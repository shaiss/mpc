import * as cdk from "aws-cdk-lib";
import * as constructs from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";

export interface MpcNodeConfig {
  /** NEAR account ID for this MPC node (e.g., "mpc-node-0.localnet") */
  accountId: string;
  /** Local address/hostname for this node (used in MPC_LOCAL_ADDRESS) */
  localAddress: string;
  /** Optional responder ID (defaults to accountId if not provided) */
  responderId?: string;
}

export interface MpcNetworkProps {
  /** VPC where MPC nodes will run */
  vpc: ec2.IVpc;
  /** NEAR RPC URL (e.g., "http://10.0.1.100:3030") */
  nearRpcUrl: string;
  /** NEAR network id for the chain the MPC indexer follows (e.g., "localnet", "testnet", "mainnet") */
  nearNetworkId: string;
  /** MPC container environment selector (for the MPC image `start.sh`). For localnet this must be "mpc-localnet". */
  mpcEnv: string;
  /** NEAR boot nodes (comma-separated list) */
  nearBootNodes: string;
  /** NEAR genesis file content (base64 encoded) for localnet */
  nearGenesis?: string;
  /** S3 URL for genesis file (if uploaded as asset) */
  genesisS3Url?: string;
  /** MPC contract ID (e.g., "v1.signer.localnet" for localnet") */
  mpcContractId: string;
  /** Configuration for each MPC node */
  nodeConfigs: MpcNodeConfig[];
  /** Docker image URI (default: Docker Hub image matching GCP production) */
  dockerImageUri?: string;
  /** CPU units per node (default: 512 = 0.5 vCPU) */
  cpu?: number;
  /** Memory per node in MB (default: 1024 = 1 GB) */
  memory?: number;
  /** Cloud Map namespace name (default: "mpc.local") */
  namespaceName?: string;
  /** Instance type for EC2 instances (default: t3.medium) */
  instanceType?: ec2.InstanceType;
  /** EBS volume size in GB (default: 100) */
  ebsVolumeSize?: number;
  /** Auto-generate test keys for sandbox/development (default: true for localnet, false otherwise) */
  autoGenerateKeys?: boolean;
}

export class MpcNetwork extends constructs.Construct {
  public readonly namespace: servicediscovery.INamespace;
  public readonly instances: ec2.Instance[];
  public readonly secrets: secretsmanager.ISecret[];
  public readonly genesisBucket?: s3.IBucket;
  public readonly genesisS3Key?: string;
  private readonly nodeSecrets: Map<number, { [key: string]: secretsmanager.ISecret }> = new Map();

  constructor(scope: constructs.Construct, id: string, props: MpcNetworkProps) {
    super(scope, id);

    const {
      vpc,
      nearRpcUrl,
      nearNetworkId,
      mpcEnv,
      nearBootNodes,
      nearGenesis,
      genesisS3Url: propsGenesisS3Url,
      mpcContractId,
      nodeConfigs,
      dockerImageUri,
      instanceType = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      ebsVolumeSize = 100,
      namespaceName = "mpc.local",
      autoGenerateKeys = nearNetworkId === "localnet",
    } = props;

    // Default to Docker Hub image matching GCP production setup
    // Users can override via dockerImageUri prop or context/env var
    const defaultImageUri =
      nearNetworkId === "testnet" || nearNetworkId === "mainnet"
        ? "docker.io/nearone/mpc-node-gcp:testnet-release"
        : "docker.io/nearone/mpc-node:3.2.0";
    const imageUri = dockerImageUri || defaultImageUri;
    
    // Load public keys from mpc-node-keys.json if it exists (for node_key.json creation)
    let nodePublicKeys: string[] = [];
    try {
      const fs = require('fs');
      const path = require('path');
      const keysPath = path.join(__dirname, '..', 'mpc-node-keys.json');
      if (fs.existsSync(keysPath)) {
        const keysData = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
        for (let i = 0; i < nodeConfigs.length; i++) {
          const nodeKey = `node-${i}`;
          if (keysData[nodeKey] && keysData[nodeKey].MPC_P2P_PUBLIC_KEY) {
            nodePublicKeys.push(keysData[nodeKey].MPC_P2P_PUBLIC_KEY);
          }
        }
        console.log(`✅ Loaded ${nodePublicKeys.length} public keys from mpc-node-keys.json`);
      }
    } catch (e) {
      console.log("⚠️  Could not load mpc-node-keys.json, will derive public keys at runtime");
    }

    // 0. Use S3 URL for genesis if provided by parent stack
    const genesisS3Url = propsGenesisS3Url;

    // 1. Create Cloud Map Namespace for service discovery (must be created before cluster)
    // Use a unique namespace name to avoid conflicts with existing hosted zones
    const uniqueNamespaceName = `mpc-${cdk.Stack.of(this).stackName.toLowerCase()}.local`;
    this.namespace = new servicediscovery.PrivateDnsNamespace(this, "MpcNamespace", {
      name: uniqueNamespaceName,
      vpc,
      description: "MPC node service discovery",
    });

    // 2. Image URI is now determined above (defaults to Docker Hub, can be overridden)

    // 3. Create Security Group for MPC nodes
    const mpcSecurityGroup = new ec2.SecurityGroup(this, "MpcSecurityGroup", {
      vpc,
      description: "Security group for MPC nodes",
      allowAllOutbound: true,
    });

    // Connected Localnet: prefer MPC nodes to peer with NEAR Base (not with each other), otherwise
    // state sync can pick an unsynced MPC peer and hang forever in the "State ...[0: header]" loop.
    const nearRpcHost = nearRpcUrl
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .split(":")[0];
    const nearRpcHostIsIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(nearRpcHost);

    // Allow MPC nodes to communicate with each other
    mpcSecurityGroup.addIngressRule(
      mpcSecurityGroup,
      ec2.Port.tcp(3030), // NEAR RPC
      "Allow NEAR RPC between MPC nodes"
    );
    mpcSecurityGroup.addIngressRule(
      mpcSecurityGroup,
      ec2.Port.tcp(8080), // MPC Web UI
      "Allow MPC Web UI access"
    );
    if (nearNetworkId === "localnet" && nearRpcHostIsIpv4) {
      mpcSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(`${nearRpcHost}/32`),
        ec2.Port.tcp(24567), // NEAR P2P
        `Allow NEAR P2P from NEAR Base (${nearRpcHost})`
      );
      // Allow NEAR base to probe MPC node health endpoint (used by in-VPC validation).
      mpcSecurityGroup.addIngressRule(
        ec2.Peer.ipv4(`${nearRpcHost}/32`),
        ec2.Port.tcp(8080), // MPC Web UI /health
        `Allow MPC Web UI from NEAR Base (${nearRpcHost})`
      );
    } else {
      mpcSecurityGroup.addIngressRule(
        mpcSecurityGroup,
        ec2.Port.tcp(24567), // NEAR P2P
        "Allow NEAR P2P between MPC nodes"
      );
    }

    // 4. Create Secrets Manager secrets for each node
    // We create individual secrets for required keys
    // Required by start.sh: MPC_ACCOUNT_SK, MPC_P2P_PRIVATE_KEY, MPC_SECRET_STORE_KEY
    // Optional: MPC_CIPHER_PK, MPC_SIGN_SK (not used by start.sh but may be needed by MPC node)
    this.secrets = [];
    const secretKeys = [
      "MPC_ACCOUNT_SK",
      "MPC_P2P_PRIVATE_KEY", 
      "MPC_SECRET_STORE_KEY",
    ];

    for (let i = 0; i < nodeConfigs.length; i++) {
      const nodeConfig = nodeConfigs[i];
      
      // Create individual secrets for each key
      // Secrets are created with placeholder values in plain text format (not JSON)
      // The deployment script will replace these with actual values
      const nodeSecrets: { [key: string]: secretsmanager.ISecret } = {};
      
      for (const keyName of secretKeys) {
        // Create secret with a simple placeholder string (NOT JSON wrapped)
        // This prevents ECS from failing when trying to retrieve secrets
        const secret = new secretsmanager.Secret(this, `Node${i}${keyName}Secret`, {
          secretName: `mpc-node-${i}-${keyName.toLowerCase()}`,
          description: `MPC node ${i} ${keyName}`,
          secretStringValue: cdk.SecretValue.unsafePlainText("PLACEHOLDER_REPLACE_WITH_REAL_KEY"),
        });
        nodeSecrets[keyName] = secret;
        this.secrets.push(secret);
      }
      
      // Store reference to node secrets for use in task definition
      this.nodeSecrets.set(i, nodeSecrets);
    }

    // 5. Create IAM Role for EC2 instances
    const instanceRole = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description: "Role for MPC node EC2 instances",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"), // For SSM access
      ],
    });

    // Grant instance role access to all secrets
    for (const secret of this.secrets) {
      secret.grantRead(instanceRole);
    }
    
    // Grant S3 access if genesis is in S3
    if (genesisS3Url) {
      instanceRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject"],
          resources: ["arn:aws:s3:::cdk-*/*"],  // CDK asset bucket pattern
        })
      );
      console.log("✅ Granted S3 read permissions for genesis download");
    }

    // Grant instance role permission to register with Cloud Map
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "servicediscovery:RegisterInstance",
          "servicediscovery:DeregisterInstance",
          "servicediscovery:GetInstance",
        ],
        resources: [this.namespace.namespaceArn],
      })
    );

    // Create instance profile
    const instanceProfile = new iam.CfnInstanceProfile(this, "InstanceProfile", {
      roles: [instanceRole.roleName],
    });

    // 6. Create EC2 Instances (one per node)
    this.instances = [];
    for (let i = 0; i < nodeConfigs.length; i++) {
      const nodeConfig = nodeConfigs[i];
      const nodeSecretsMap = this.nodeSecrets.get(i)!;

      // Create EBS volume for this node
      // Use DESTROY policy for localnet to ensure clean teardown and avoid stale data on redeploy.
      // For production/testnet deployments, consider RETAIN or SNAPSHOT policies.
      const ebsVolume = new ec2.Volume(this, `Node${i}Volume`, {
        availabilityZone: vpc.availabilityZones[0], // Use first AZ
        size: cdk.Size.gibibytes(ebsVolumeSize),
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        encrypted: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY, // Clean teardown for localnet dev workflow
      });

      // Generate UserData script
      const userData = this.generateUserDataScript({
        nodeIndex: i,
        nodeConfig,
        imageUri,
        mpcContractId,
        nearNetworkId,
        mpcEnv,
        nearRpcUrl,
        nearBootNodes,
        nearGenesis,
        genesisS3Url,
        nodeSecretsMap,
        namespaceId: this.namespace.namespaceId,
        nodePublicKey: nodePublicKeys[i],
      });

      // Create EC2 instance
      const instance = new ec2.Instance(this, `Node${i}Instance`, {
        vpc,
        instanceType,
        machineImage: ec2.MachineImage.latestAmazonLinux2023({
          cpuType: ec2.AmazonLinuxCpuType.X86_64,
        }),
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          // subnetType: ec2.SubnetType.PUBLIC, // DEBUG: use public subnet for now to rule out NAT issues
        },
        securityGroup: mpcSecurityGroup,
        role: instanceRole,
        userData: ec2.UserData.custom(userData),
        blockDevices: [
          {
            deviceName: "/dev/xvda",
            volume: ec2.BlockDeviceVolume.ebs(20, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
              deleteOnTermination: true,
            }),
          },
        ],
      });

      // Attach EBS volume to instance
      instance.node.addDependency(ebsVolume);
      new ec2.CfnVolumeAttachment(this, `Node${i}VolumeAttachment`, {
        instanceId: instance.instanceId,
        volumeId: ebsVolume.volumeId,
        device: "/dev/sdf", // Standard EBS device name
      });

      // Register instance with Cloud Map for service discovery
      const service = new servicediscovery.Service(this, `Node${i}Service`, {
        namespace: this.namespace,
        name: `node-${i}`,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: cdk.Duration.seconds(60),
      });

      // Register the instance IP with Cloud Map
      // Note: This requires the instance to be running, so we use a custom resource
      // or rely on UserData script to register via AWS CLI
      // For now, we'll add the registration to UserData script

      this.instances.push(instance);
    }

    // Stack outputs
    new cdk.CfnOutput(this, "MpcNamespaceId", {
      value: this.namespace.namespaceId,
      exportName: "MpcNamespaceId",
    });

    for (let i = 0; i < this.instances.length; i++) {
      const nodeConfig = nodeConfigs[i];
      
      new cdk.CfnOutput(this, `Node${i}InstanceId`, {
        value: this.instances[i].instanceId,
        exportName: `MpcNode${i}InstanceId`,
        description: `EC2 Instance ID for MPC Node ${i}`,
      });

      new cdk.CfnOutput(this, `Node${i}PrivateIp`, {
        value: this.instances[i].instancePrivateIp,
        exportName: `MpcNode${i}PrivateIp`,
        description: `Private IP address for MPC Node ${i}`,
      });

      new cdk.CfnOutput(this, `Node${i}AccountId`, {
        value: nodeConfig.accountId,
        exportName: `MpcNode${i}AccountId`,
        description: `NEAR account ID for MPC Node ${i}`,
      });
    }
  }

  /**
   * Generates UserData script for EC2 instance startup
   * Similar to GCP's cloud-config, this script:
   * 1. Formats and mounts the EBS volume
   * 2. Installs Docker
   * 3. Pulls the Docker image from Docker Hub (or configured registry)
   * 4. Fetches secrets from Secrets Manager
   * 5. Runs the MPC node container
   */
  private generateUserDataScript(params: {
    nodeIndex: number;
    nodeConfig: MpcNodeConfig;
    imageUri: string;
    mpcContractId: string;
    nearNetworkId: string;
    mpcEnv: string;
    nearRpcUrl: string;
    nearBootNodes: string;
    nearGenesis?: string;
    genesisS3Url?: string;
    nodeSecretsMap: { [key: string]: secretsmanager.ISecret };
    namespaceId: string;
    nodePublicKey?: string;
  }): string {
    const {
      nodeIndex,
      nodeConfig,
      imageUri,
      mpcContractId,
      nearNetworkId,
      mpcEnv,
      nearRpcUrl,
      nearBootNodes,
      nearGenesis,
      genesisS3Url,
      nodeSecretsMap,
      namespaceId,
      nodePublicKey,
    } = params;

    const dataDir = "/data";
    const region = cdk.Stack.of(this).region;

    // Get secret ARNs for AWS CLI retrieval
    const accountSkSecretArn = nodeSecretsMap.MPC_ACCOUNT_SK.secretArn;
    const p2pKeySecretArn = nodeSecretsMap.MPC_P2P_PRIVATE_KEY.secretArn;
    const secretStoreKeySecretArn = nodeSecretsMap.MPC_SECRET_STORE_KEY.secretArn;

    // Genesis file is too large for UserData (>25KB limit)
    // For Connected Localnet mode, we'll use boot nodes to sync to NEAR Base
    // and rely on NEAR's state sync instead of embedding full genesis
    const genesisContent = "";  // Don't embed genesis in UserData

    return `#!/bin/bash
    set -exo pipefail

# Install Docker
yum update -y
yum install -y docker jq
systemctl start docker
systemctl enable docker
usermod -a -G docker ec2-user

# Install AWS CLI v2 if not present
if ! command -v aws &> /dev/null; then
  curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
  yum install -y unzip
  unzip awscliv2.zip
  ./aws/install
fi

# Wait for EBS volume to be attached
# EBS volumes attached as /dev/sdf appear as /dev/nvme1n1 on newer instance types
# Try both device names
DEVICE=""
for dev in /dev/nvme1n1 /dev/sdf /dev/xvdf; do
  if [ -e $dev ]; then
    DEVICE=$dev
    break
  fi
done

if [ -z "$DEVICE" ]; then
  echo "Waiting for EBS volume to attach..."
  sleep 5
  # Try again after a short wait
  for dev in /dev/nvme1n1 /dev/sdf /dev/xvdf; do
    if [ -e $dev ]; then
      DEVICE=$dev
      break
    fi
  done
fi

if [ -z "$DEVICE" ]; then
  echo "ERROR: Could not find attached EBS volume"
  exit 1
fi

echo "Found EBS volume at $DEVICE"

# Format and mount the EBS volume
if ! blkid $DEVICE | grep -q ext4; then
  echo "Formatting $DEVICE as ext4..."
  mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard $DEVICE
fi

mkdir -p ${dataDir}
mount -o discard,defaults $DEVICE ${dataDir}

# Add to fstab for persistence
UUID=$(blkid -s UUID -o value $DEVICE)
if ! grep -q "$UUID" /etc/fstab; then
  echo "UUID=$UUID ${dataDir} ext4 discard,defaults,nofail 0 2" >> /etc/fstab
fi

# Fetch secrets from Secrets Manager.
# IMPORTANT: Secrets are created with placeholder values during stack creation and then populated later.
# We wait until the placeholder is replaced so first-boot doesn't permanently bake bad env vars into the container.
fetch_secret() {
  aws secretsmanager get-secret-value --secret-id "$1" --region ${region} --query SecretString --output text
}

wait_for_real_secret() {
  local name="$1"
  local arn="$2"
  local val=""

  for attempt in $(seq 1 60); do
    val="$(fetch_secret "$arn" 2>/dev/null || true)"
    if [ -n "$val" ] && [ "$val" != "PLACEHOLDER_REPLACE_WITH_REAL_KEY" ]; then
      echo "$val"
      return 0
    fi
    # IMPORTANT: progress logs must go to stderr, otherwise they get captured into the secret value
    # and we end up writing invalid keys into /data/secrets.json.
    echo "⏳ Waiting for $name secret to be populated..." >&2
    sleep 10
  done

  echo "ERROR: Timed out waiting for $name secret to be populated" >&2
  exit 1
}

export MPC_ACCOUNT_SK="$(wait_for_real_secret MPC_ACCOUNT_SK ${accountSkSecretArn})"
export MPC_P2P_PRIVATE_KEY="$(wait_for_real_secret MPC_P2P_PRIVATE_KEY ${p2pKeySecretArn})"
export MPC_SECRET_STORE_KEY="$(wait_for_real_secret MPC_SECRET_STORE_KEY ${secretStoreKeySecretArn})"

# Normalize secrets (strip newlines)
MPC_ACCOUNT_SK="$(echo "$MPC_ACCOUNT_SK" | tr -d '\n')"
MPC_P2P_PRIVATE_KEY="$(echo "$MPC_P2P_PRIVATE_KEY" | tr -d '\n')"
MPC_SECRET_STORE_KEY="$(echo "$MPC_SECRET_STORE_KEY" | tr -d '\n')"
export MPC_ACCOUNT_SK MPC_P2P_PRIVATE_KEY MPC_SECRET_STORE_KEY

# Fail fast if secrets are malformed (prevents crash loops with opaque errors).
if ! echo "$MPC_ACCOUNT_SK" | grep -q '^ed25519:'; then
  echo "ERROR: MPC_ACCOUNT_SK must start with 'ed25519:'" >&2
  exit 1
fi
if ! echo "$MPC_P2P_PRIVATE_KEY" | grep -q '^ed25519:'; then
  echo "ERROR: MPC_P2P_PRIVATE_KEY must start with 'ed25519:'" >&2
  exit 1
fi

# Ensure MPC config.yaml exists (mpc-node reads it directly; /app/start.sh would otherwise generate it).
if [ ! -f ${dataDir}/config.yaml ]; then
  cat > ${dataDir}/config.yaml <<EOF
# Configuration File
my_near_account_id: ${nodeConfig.accountId}
near_responder_account_id: ${nodeConfig.responderId || nodeConfig.accountId}
number_of_responder_keys: 50
web_ui:
  host: 0.0.0.0
  port: 8080
migration_web_ui:
  host: 0.0.0.0
  port: 8079
triple:
  concurrency: 2
  desired_triples_to_buffer: 1000000
  timeout_sec: 60
  parallel_triple_generation_stagger_time_sec: 1
presignature:
  concurrency: 16
  desired_presignatures_to_buffer: 8192
  timeout_sec: 60
signature:
  timeout_sec: 60
ckd:
  timeout_sec: 60
indexer:
  validate_genesis: false
  sync_mode: Latest
  concurrency: 1
  mpc_contract_id: ${mpcContractId}
  finality: optimistic
cores: 12
EOF
  chmod 644 ${dataDir}/config.yaml || true
fi

# Ensure secrets.json exists (mpc-node will use existing secrets.json if present; otherwise it generates random keys).
if [ ! -f ${dataDir}/secrets.json ]; then
  cat > ${dataDir}/secrets.json <<EOF
{
  "p2p_private_key": "$MPC_P2P_PRIVATE_KEY",
  "near_signer_key": "$MPC_ACCOUNT_SK",
  "near_responder_keys": ["$MPC_ACCOUNT_SK"]
}
EOF
  chmod 600 ${dataDir}/secrets.json || true
fi

# Connected Localnet Mode: Download genesis from S3 if provided
GENESIS_S3_URL="${genesisS3Url ?? ""}"
MPC_ENV_VAL="${mpcEnv}"

if [ -n "$GENESIS_S3_URL" ]; then
  echo "📡 Connected Localnet mode - downloading NEAR Base genesis from S3"
  echo "   S3 URL: $GENESIS_S3_URL"
  
  # Download genesis from S3
  aws s3 cp "$GENESIS_S3_URL" ${dataDir}/genesis.json --region ${region}
  
  # Verify download
  if [ ! -f ${dataDir}/genesis.json ]; then
    echo "ERROR: Failed to download genesis from S3"
    exit 1
  fi
  
  GENESIS_SIZE=$(wc -c < ${dataDir}/genesis.json)
  echo "✅ Genesis downloaded: $GENESIS_SIZE bytes"
  
  # Export boot nodes as bash variable for reset script and nearcore init
  # This is CRITICAL - without this, MPC nodes will have 0 peers (GOTCHA #15.5)
  NEAR_BOOT_NODES="${nearBootNodes}"
  CHAIN_ID="$(jq -r '.chain_id' ${dataDir}/genesis.json)"
  IMAGE_URI="${imageUri}"
  export NEAR_BOOT_NODES CHAIN_ID IMAGE_URI
  echo "Boot nodes configured: $NEAR_BOOT_NODES"
  echo "Chain ID: $CHAIN_ID"
  
  # IMPORTANT: In localnet we set MPC_ENV to "mpc-localnet" so /app/start.sh disables state sync,
  # but we PRE-INIT /data/config.json using our provided genesis (so it won't use embedded genesis).
  MPC_ENV_VAL="${mpcEnv}"
elif [ -n "${nearBootNodes}" ]; then
  echo "⚠️  Boot nodes provided but no S3 genesis URL"
  echo "   Will use embedded genesis (may cause chain_id mismatch)"
  MPC_ENV_VAL="${mpcEnv}"
fi

# Pull the Docker image (from Docker Hub or configured registry)
docker pull ${imageUri}

# Embed reset script for reuse by SSM commands
mkdir -p /opt/mpc
cat > /opt/mpc/reset-mpc-node.sh << 'MPC_RESET_EOF'
#!/bin/bash
# MPC Node Reset Script (embedded in UserData)
# Resets NEAR chain state and MPC keyshares while preserving secrets
# Called during instance boot or via SSM for running instances

set -exo pipefail

echo "=== MPC Node Reset Started ==="
date

# Arguments with defaults (passed from UserData or SSM)
GENESIS_S3_URL="\${1:-\${GENESIS_S3_URL}}"
IMAGE_URI="\${2:-\${IMAGE_URI}}"
CHAIN_ID="\${3:-\${CHAIN_ID}}"
NEAR_BOOT_NODES="\${4:-\${NEAR_BOOT_NODES}}"

# Default to Connected Localnet values if not provided
if [ -z "$CHAIN_ID" ]; then
  CHAIN_ID="localnet"
fi

# Get AWS region from instance metadata (with fallback to environment variable)
if [ -z "\${AWS_REGION}" ]; then
  AWS_REGION="$(curl -s http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null || echo 'us-east-1')"
fi

echo "Configuration:"
echo "  GENESIS_S3_URL: $GENESIS_S3_URL"
echo "  IMAGE_URI: $IMAGE_URI"
echo "  CHAIN_ID: $CHAIN_ID"
echo "  NEAR_BOOT_NODES: $NEAR_BOOT_NODES"
echo "  AWS_REGION: $AWS_REGION"

# Stop the Docker container
echo "=== Stopping MPC container ==="
docker stop mpc-node || true
docker rm mpc-node || true

# Create backup directory for essential files
mkdir -p /tmp/mpc-reset-backup

# Backup essential config files (will be restored after wipe)
if [ -f /data/config.yaml ]; then
  cp /data/config.yaml /tmp/mpc-reset-backup/
  echo "Backed up config.yaml"
fi

if [ -f /data/secrets.json ]; then
  cp /data/secrets.json /tmp/mpc-reset-backup/
  echo "Backed up secrets.json"
fi

# Wipe NEAR chain state and MPC keyshares (preserve logs for debugging)
echo "=== Wiping NEAR chain state and MPC keyshares ==="
rm -rf /data/data /data/config.json /data/node_key.json /data/validator_key.json
rm -rf /data/permanent_keys /data/temporary_keys

# Download genesis from S3 if URL provided (Connected Localnet mode)
if [ -n "$GENESIS_S3_URL" ]; then
  echo "=== Downloading genesis from S3 ==="
  aws s3 cp "$GENESIS_S3_URL" /data/genesis.json --region "$AWS_REGION"

  # Verify download
  if [ ! -f /data/genesis.json ]; then
    echo "ERROR: Failed to download genesis from S3: $GENESIS_S3_URL"
    exit 1
  fi

  GENESIS_SIZE="$(wc -c < /data/genesis.json)"
  echo "✅ Genesis downloaded: $GENESIS_SIZE bytes"
fi

# Restore essential config files
if [ -f /tmp/mpc-reset-backup/config.yaml ]; then
  cp /tmp/mpc-reset-backup/config.yaml /data/
  echo "Restored config.yaml"
fi

if [ -f /tmp/mpc-reset-backup/secrets.json ]; then
  cp /tmp/mpc-reset-backup/secrets.json /data/
  echo "Restored secrets.json"
fi

# Reinitialize nearcore config if we have genesis and boot nodes
if [ -f /data/genesis.json ] && [ -n "$NEAR_BOOT_NODES" ]; then
  echo "=== Creating nearcore config WITHOUT using mpc-node init (to preserve genesis hash) ==="

  # Clean any previously-written minimal/invalid config
  rm -f /data/config.json /data/validator_key.json || true

  # CRITICAL: Do NOT use 'mpc-node init' - it modifies the genesis file and changes its hash (GOTCHA #15.6)
  # Instead, manually create config.json with the exact boot_nodes we need
  
  # Use mpc-node init to create config.json with boot_nodes
  # Then restore the original genesis to preserve its hash (GOTCHA #15.6)
  cp /data/genesis.json /data/genesis.backup
  
  docker run --rm --net=host -v /data:/data --entrypoint /app/mpc-node \${IMAGE_URI} \\
    init --dir /data --chain-id "\${CHAIN_ID}" --genesis /data/genesis.json --boot-nodes "\${NEAR_BOOT_NODES}"
  
  # CRITICAL: Restore original genesis immediately (mpc-node init modifies it)
  cp /data/genesis.backup /data/genesis.json
  rm /data/genesis.backup
  
  echo "✅ config.json created with boot_nodes (genesis hash preserved)"
  
  # Update node_key.json with correct account_id (init creates it with "node", we need full account)
  if [ -f /data/node_key.json ]; then
    P2P_PRIVATE_KEY=\$(jq -r '.p2p_private_key' /data/secrets.json)
    P2P_PUBLIC_KEY="${nodePublicKey || ""}"
    
    cat > /data/node_key.json <<EOF
{
  "account_id": "${nodeConfig.accountId}",
  "public_key": "\$P2P_PUBLIC_KEY",
  "secret_key": "\$P2P_PRIVATE_KEY"
}
EOF
    chmod 600 /data/node_key.json
    echo "✅ node_key.json updated with correct account_id and public key"
  fi
  
  # Force state_sync and remove conflicting tracked_shards (use tracked_shards_config instead)
  cp /data/config.json /data/config.json.bak
  jq '.state_sync_enabled=true | del(.tracked_shards) | .tracked_shards_config="AllShards"' /data/config.json.bak > /data/config.json
  rm /data/config.json.bak
  echo "✅ Config updated: state_sync_enabled=true, tracked_shards_config=AllShards"
  
  # Remove validator key (MPC nodes are NOT validators)
  rm -f /data/validator_key.json || true

else
  echo "=== Skipping nearcore init (no genesis or boot nodes) ==="
fi

# Clean up backup
rm -rf /tmp/mpc-reset-backup

echo "=== MPC Node Reset Complete ==="
date

echo "=== Next steps ==="
echo "Container will be started by main UserData script after this reset completes"
echo "1. Wait for MPC node to sync (check logs with: docker logs mpc-node --tail 20)"
echo "2. Verify keygen starts (contract should be in 'Running' state)"
echo "3. Run parity tests to confirm signing works"
MPC_RESET_EOF
chmod +x /opt/mpc/reset-mpc-node.sh

# Connected Localnet: ensure /data/config.json is a valid nearcore config file.
# Use the embedded reset script for initialization
if [ -n "$GENESIS_S3_URL" ]; then
  NEED_NEAR_INIT="false"
  if [ ! -f ${dataDir}/config.json ]; then
    NEED_NEAR_INIT="true"
  else
    if ! grep -q '\"store\"' ${dataDir}/config.json; then NEED_NEAR_INIT="true"; fi
    if ! grep -q '\"rpc\"' ${dataDir}/config.json; then NEED_NEAR_INIT="true"; fi
    if ! grep -q '\"addr\"' ${dataDir}/config.json; then NEED_NEAR_INIT="true"; fi
  fi

  # If the NEAR base chain_id changes (e.g., NEAR base was redeployed), force init so config.json matches genesis.json.
  GENESIS_CHAIN_ID="$(jq -r '.chain_id // empty' ${dataDir}/genesis.json 2>/dev/null || true)"
  CONFIG_CHAIN_ID="$(jq -r '.chain_id // empty' ${dataDir}/config.json 2>/dev/null || true)"
  if [ -n "$GENESIS_CHAIN_ID" ] && [ -n "$CONFIG_CHAIN_ID" ] && [ "$GENESIS_CHAIN_ID" != "$CONFIG_CHAIN_ID" ]; then
    echo "⚠️  Detected chain_id mismatch (config=$CONFIG_CHAIN_ID genesis=$GENESIS_CHAIN_ID); forcing init" >&2
    NEED_NEAR_INIT="true"
  fi

  if [ "$NEED_NEAR_INIT" = "true" ]; then
    echo "🧱 Initializing MPC node via reset script"
    # Export AWS_REGION for the reset script (it needs it for S3 download)
    export AWS_REGION="${region}"
    /opt/mpc/reset-mpc-node.sh "$GENESIS_S3_URL" "${imageUri}" "$CHAIN_ID" "${nearBootNodes}"
  else
    echo "✅ Existing /data/config.json looks valid; skipping init"
  fi
fi

# Stop and remove any existing container
docker stop mpc-node || true
docker rm mpc-node || true

# Run the MPC node container
if [ -n "$GENESIS_S3_URL" ]; then
  # Connected Localnet: bypass /app/start.sh (it disables state sync for mpc-localnet, and for other envs it expects
  # config.state_sync to exist and crashes). We manage /data/* ourselves and run the binary directly.
  
  # Extract hex value from MPC_SECRET_STORE_KEY (remove ed25519: prefix if present)
  SECRET_STORE_KEY_HEX=$(echo "$MPC_SECRET_STORE_KEY" | sed 's/^ed25519://')
  
  docker run -d --name mpc-node --restart=always --net=host \\
    -v ${dataDir}:/data \\
    -e MPC_HOME_DIR="/data" \\
    -e MPC_ACCOUNT_SK="$MPC_ACCOUNT_SK" \\
    -e MPC_P2P_PRIVATE_KEY="$MPC_P2P_PRIVATE_KEY" \\
    -e MPC_SECRET_STORE_KEY="$MPC_SECRET_STORE_KEY" \\
    -e RUST_BACKTRACE="full" \\
    -e RUST_LOG="mpc=debug,info" \\
    --entrypoint /app/mpc-node \\
    ${imageUri} start --home-dir /data $SECRET_STORE_KEY_HEX local
else
  # Legacy behavior: use image entrypoint (/app/start.sh)
  docker run -d --name mpc-node --restart=always --net=host \\
    -v ${dataDir}:/data \\
    -e MPC_HOME_DIR="/data" \\
    -e MPC_ACCOUNT_ID="${nodeConfig.accountId}" \\
    -e MPC_LOCAL_ADDRESS="${nodeConfig.localAddress}" \\
    -e MPC_RESPONDER_ID="${nodeConfig.responderId || nodeConfig.accountId}" \\
    -e MPC_CONTRACT_ID="${mpcContractId}" \\
    -e MPC_ENV="$MPC_ENV_VAL" \\
    -e NEAR_RPC_URL="${nearRpcUrl}" \\
    -e NEAR_BOOT_NODES="${nearBootNodes}" \\
    -e MPC_ACCOUNT_SK="$MPC_ACCOUNT_SK" \\
    -e MPC_P2P_PRIVATE_KEY="$MPC_P2P_PRIVATE_KEY" \\
    -e MPC_SECRET_STORE_KEY="$MPC_SECRET_STORE_KEY" \\
    -e RUST_BACKTRACE="full" \\
    -e RUST_LOG="mpc=debug,info" \\
    ${imageUri}
fi

# Register with Cloud Map (optional - for service discovery)
INSTANCE_IP=$(curl -s http://169.254.169.254/latest/meta-data/local-ipv4)
NAMESPACE_ID="${namespaceId}"
SERVICE_ID=$(aws servicediscovery list-services --filters Name=NAMESPACE_ID,Values=$NAMESPACE_ID --query "Services[?Name=='node-${nodeIndex}'].Id" --output text --region ${region})

if [ ! -z "$SERVICE_ID" ]; then
  aws servicediscovery register-instance \\
    --service-id $SERVICE_ID \\
    --instance-id "node-${nodeIndex}" \\
    --attributes A="$INSTANCE_IP" \\
    --region ${region} || true
fi

echo "MPC node ${nodeIndex} startup complete"
`;
  }
}
