# MPC Stack Integration Guide

This guide explains how to deploy the MPC stack in different architectural patterns following AWS best practices for modular, loosely-coupled infrastructure.

## Architecture Overview

The MPC CDK stack supports **three deployment patterns**:

1. **Standalone** - Deploy independently with manual configuration
2. **Integrated** - Auto-import from AWSNodeRunner stack exports  
3. **Composed** - Use as component in parent stack

```
┌─────────────────────────────────────────────────────────────┐
│  Pattern 1: STANDALONE (Manual Configuration)               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  User provides:                                              │
│  --context vpcId=vpc-xxxxx                                  │
│  --context nearRpcUrl=http://x.x.x.x:3030                  │
│  --context nearBootNodes=ed25519:KEY@IP:PORT               │
│                                                              │
│  ┌────────────────────────────────┐                         │
│  │   MpcStandaloneStack           │                         │
│  │   (fully independent)          │                         │
│  └────────────────────────────────┘                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Pattern 2: INTEGRATED (CloudFormation Exports)             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────────────────────┐                         │
│  │   AWSNodeRunnerStack           │                         │
│  │   Exports:                     │                         │
│  │   - VpcId                      │                         │
│  │   - NearRpcUrl                 │                         │
│  │   - NearBootNodes              │                         │
│  │   - MpcContractId              │                         │
│  └────────────────────────────────┘                         │
│              ↓ (CloudFormation)                              │
│  ┌────────────────────────────────┐                         │
│  │   MpcStandaloneStack           │                         │
│  │   Imports from exports         │                         │
│  │   --context importFromStack=true                        │
│  └────────────────────────────────┘                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Pattern 3: COMPOSED (Parent Stack)                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────┐           │
│  │   NearMpcIntegratedStack (parent)            │           │
│  │                                               │           │
│  │   ┌─────────────────┐  ┌──────────────────┐ │           │
│  │   │ NEAR Node       │  │ MPC Network      │ │           │
│  │   │ (construct)     │→ │ (construct)      │ │           │
│  │   └─────────────────┘  └──────────────────┘ │           │
│  │                                               │           │
│  └──────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

---

## Pattern 1: Standalone Deployment

**Use Case**: You already have a NEAR node running and just need MPC nodes.

### Prerequisites
- Existing VPC with private subnets
- NEAR RPC node accessible at a private IP
- Boot nodes configuration

### Deployment

```bash
cd infra/aws-cdk

npx cdk deploy \
  --context vpcId=vpc-0ad7ab6659e0293ae \
  --context nearRpcUrl=http://10.0.5.132:3030 \
  --context nearBootNodes=ed25519:PUBKEY@10.0.5.132:24567 \
  --context mpcContractId=v1.signer.node0 \
  --profile shai-sandbox-profile \
  --require-approval never
```

### Environment Variables (Alternative)

```bash
export VPC_ID=vpc-0ad7ab6659e0293ae
export NEAR_RPC_URL=http://10.0.5.132:3030
export NEAR_BOOT_NODES=ed25519:PUBKEY@10.0.5.132:24567
export MPC_CONTRACT_ID=v1.signer.node0

npx cdk deploy --profile shai-sandbox-profile
```

---

## Pattern 2: Integrated Deployment

**Use Case**: Deploy with AWSNodeRunner stack for automatic configuration.

### Step 1: Update AWSNodeRunner to Export Values

**File: `AWSNodeRunner/lib/near-node-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';

export class NearNodeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ... your existing VPC and EC2 setup ...

    // Export values for MPC stack integration
    new cdk.CfnOutput(this, 'VpcIdOutput', {
      value: vpc.vpcId,
      exportName: `${this.stackName}-VpcId`,
      description: 'VPC ID for MPC node deployment'
    });

    new cdk.CfnOutput(this, 'NearRpcUrlOutput', {
      value: `http://${instance.instancePrivateIp}:3030`,
      exportName: `${this.stackName}-NearRpcUrl`,
      description: 'NEAR RPC private endpoint'
    });

    new cdk.CfnOutput(this, 'NearBootNodesOutput', {
      value: `${nodeKey}@${instance.instancePrivateIp}:24567`,
      exportName: `${this.stackName}-NearBootNodes`,
      description: 'NEAR boot nodes for MPC indexer'
    });

    new cdk.CfnOutput(this, 'NearNetworkIdOutput', {
      value: 'mpc-localnet', // or 'testnet', 'mainnet'
      exportName: `${this.stackName}-NearNetworkId`,
      description: 'NEAR network/chain ID'
    });

    new cdk.CfnOutput(this, 'MpcContractIdOutput', {
      value: 'v1.signer.node0', // adjust for your network
      exportName: `${this.stackName}-MpcContractId`,
      description: 'MPC contract account ID'
    });
  }
}
```

### Step 2: Deploy AWSNodeRunner

```bash
cd AWSNodeRunner
npx cdk deploy --profile shai-sandbox-profile
```

### Step 3: Deploy MPC Stack with Import

```bash
cd mpc-repo/infra/aws-cdk

npx cdk deploy \
  --context importFromStack=true \
  --context awsNodeRunnerStackName=AWSNodeRunnerStack \
  --profile shai-sandbox-profile \
  --require-approval never
```

The MPC stack will automatically import:
- ✅ VPC ID
- ✅ NEAR RPC URL
- ✅ Boot nodes
- ✅ Network ID
- ✅ Contract ID

---

## Pattern 3: Composed Stack (Advanced)

**Use Case**: Deploy both as a single integrated system with proper dependency management.

### Create Parent Stack

**File: `near-mpc-integrated/lib/integrated-stack.ts`**

```typescript
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { NearNodeStack } from '../../AWSNodeRunner/lib/near-node-stack';
import { MpcNetwork } from '../../mpc-repo/infra/aws-cdk/lib/mpc-network';

export class NearMpcIntegratedStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Create or import VPC
    const vpc = new ec2.Vpc(this, 'NearMpcVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // 2. Deploy NEAR Node (as nested construct, not separate stack)
    // Note: This would require refactoring NearNodeStack to be a Construct
    // For now, deploy as separate stack and import

    // 3. Deploy MPC Network (as construct)
    const mpcNetwork = new MpcNetwork(this, 'MpcNetwork', {
      vpc,
      nearRpcUrl: 'http://10.0.5.132:3030', // from NEAR node
      nearNetworkId: 'mpc-localnet',
      nearBootNodes: 'ed25519:PUBKEY@10.0.5.132:24567',
      mpcContractId: 'v1.signer.node0',
      nodeConfigs: [
        { accountId: 'mpc-node-0.node0', localAddress: 'node-0.mpc.local' },
        { accountId: 'mpc-node-1.node0', localAddress: 'node-1.mpc.local' },
        { accountId: 'mpc-node-2.node0', localAddress: 'node-2.mpc.local' },
      ],
    });

    // 4. Output integrated endpoints
    new cdk.CfnOutput(this, 'MpcClusterArn', {
      value: mpcNetwork.cluster.clusterArn,
      description: 'MPC ECS Cluster ARN',
    });

    new cdk.CfnOutput(this, 'MpcEndpoints', {
      value: `http://node-{0,1,2}.${mpcNetwork.namespace.namespaceName}:8080`,
      description: 'MPC node HTTP endpoints',
    });
  }
}
```

### Deploy Integrated Stack

```bash
cd near-mpc-integrated

npx cdk deploy --profile shai-sandbox-profile
```

---

## CloudFormation Exports Reference

### Required Exports from AWSNodeRunner

For Pattern 2 (Integrated), the AWSNodeRunner stack **must** export these values:

| Export Name | Description | Example Value |
|-------------|-------------|---------------|
| `{StackName}-VpcId` | VPC ID where NEAR node runs | `vpc-0ad7ab6659e0293ae` |
| `{StackName}-NearRpcUrl` | NEAR RPC private endpoint | `http://10.0.5.132:3030` |
| `{StackName}-NearBootNodes` | Boot nodes for MPC indexer | `ed25519:ABC...@10.0.5.132:24567` |
| `{StackName}-NearNetworkId` | NEAR network/chain ID | `mpc-localnet` |
| `{StackName}-MpcContractId` | MPC contract account | `v1.signer.node0` |

### Example CloudFormation Output

```yaml
Outputs:
  VpcIdOutput:
    Value: !Ref VPC
    Export:
      Name: !Sub "${AWS::StackName}-VpcId"
  NearRpcUrlOutput:
    Value: !Sub "http://${NearInstance.PrivateIp}:3030"
    Export:
      Name: !Sub "${AWS::StackName}-NearRpcUrl"
```

---

## Configuration Priority

The MPC stack resolves configuration in this order:

1. **Explicit props** (highest priority)
2. **CloudFormation imports** (if `importFromStack=true`)
3. **Default values** (lowest priority)

```typescript
// Example resolution
nearRpcUrl = 
  propsNearRpcUrl ||                              // 1. Explicit prop
  (importFromStack ? Fn.importValue("...") : null) || // 2. Import
  "http://localhost:3030";                        // 3. Default
```

This allows:
- ✅ Override imports with explicit values if needed
- ✅ Use imports when available
- ✅ Fall back to sensible defaults

---

## Benefits of This Architecture

### 1. Modularity ✅
Each stack is **self-contained** and can be:
- Developed independently
- Tested independently
- Deployed independently
- Versioned independently

### 2. Reusability ✅
Stacks are **composable**:
- Use MpcNetwork construct in any stack
- Import into parent stacks
- Share across projects

### 3. Flexibility ✅
**Multiple deployment paths**:
- DIY users: Bring your own VPC/NEAR node
- Quick start: Deploy integrated stack
- Enterprise: Compose into larger systems

### 4. AWS Best Practices ✅
Follows **Well-Architected Framework**:
- **Loose Coupling**: Stacks communicate via contracts (exports)
- **Service Discovery**: CloudFormation as service registry
- **Fail-Safe Defaults**: Graceful degradation
- **Infrastructure as Code**: Declarative configuration

---

## Migration Guide

### From Manual to Integrated

**Current deployment:**
```bash
npx cdk deploy --context vpcId=vpc-xxx ...
```

**Migrate to:**
```bash
# 1. Update AWSNodeRunner to export values (one-time)
# 2. Redeploy AWSNodeRunner
npx cdk deploy -c stack=aws-node-runner

# 3. Deploy MPC with imports
npx cdk deploy -c importFromStack=true -c awsNodeRunnerStackName=AWSNodeRunnerStack
```

**Benefits:**
- No more manual parameter passing
- Auto-sync when NEAR node changes
- CloudFormation dependency tracking

---

## Troubleshooting

### Error: "Export ... does not exist"

**Cause**: AWSNodeRunner stack doesn't export required values

**Fix**: Update AWSNodeRunner stack to include CloudFormation outputs (see Step 1 of Pattern 2)

### Error: "Circular dependency detected"

**Cause**: Both stacks trying to import from each other

**Fix**: Ensure one-way dependency: AWSNodeRunner exports → MPC imports

### Warning: "Using default values"

**Cause**: Neither props nor imports provided

**Fix**: Either provide context parameters or enable `importFromStack=true`

---

## Examples

### Example 1: Local Testing (Standalone)
```bash
# Deploy with local NEAR node
npx cdk deploy \
  --context vpcId=$(aws ec2 describe-vpcs --query 'Vpcs[0].VpcId' --output text) \
  --context nearRpcUrl=http://localhost:3030 \
  --context nearBootNodes=""
```

### Example 2: Production (Integrated)
```bash
# Deploy AWSNodeRunner first
cd AWSNodeRunner && npx cdk deploy

# Deploy MPC with auto-import
cd mpc-repo/infra/aws-cdk
npx cdk deploy --context importFromStack=true
```

### Example 3: Multi-Region (Composed)
```bash
# Deploy parent stack that creates both
cd near-mpc-integrated
npx cdk deploy --context region=us-west-2
```

---

## Next Steps

1. **Choose your pattern** based on use case
2. **Update AWSNodeRunner** if using Pattern 2/3 (add exports)
3. **Deploy** using appropriate commands
4. **Test** integration between stacks
5. **Document** your deployment choices

For detailed deployment instructions, see [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md).

