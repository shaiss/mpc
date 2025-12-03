#!/usr/bin/env python3
"""
Tests migration service (migrating a node).
Starts 2 nodes, have node #1 migrate to node #3
At every step we check that signatures can still be produced.
"""

import json
import pathlib
import subprocess
import sys
import os
import time
import base58
import pytest

from nacl.signing import SigningKey

from common_lib.constants import BACKUP_SERVICE_BINARY_PATH, MPC_REPO_DIR
from common_lib.contract_state import ProtocolState
from common_lib.migration_state import BackupServiceInfo
from common_lib.shared.mpc_cluster import MpcCluster
from common_lib.shared.mpc_node import MpcNode

sys.path.append(str(pathlib.Path(__file__).resolve().parents[1]))
from common_lib import shared
from common_lib.contracts import load_mpc_contract


def set_up_backup_service(home_dir: str):
    cmd = (
        BACKUP_SERVICE_BINARY_PATH,
        "--home-dir",
        home_dir,
        "generate-keys",
    )
    print(f"running command:\n{cmd}\n")
    subprocess.run(cmd)


def call_backup_service(mpc_node: MpcNode, home_dir: str):
    url = mpc_node.migration_service_url
    p2p_key = mpc_node.p2p_public_key
    backup_encryption_key = mpc_node.backup_key
    cmd = (
        BACKUP_SERVICE_BINARY_PATH,
        "--home-dir",
        home_dir,
        "get-keyshares",
        "--mpc-node-url",
        url,
        "--mpc-node-p2p-key",
        p2p_key,
        "--backup-encryption-key-hex",
        backup_encryption_key.hex(),
    )
    print(f"running command:\n{cmd}\n")
    subprocess.run(cmd)
    ##


# [2m2025-12-03T12:22:47.712775Z[0m [32m INFO[0m [2mmpc_node::indexer::migrations[0m[2m:[0m my migration state changed: MigrationInfo { backup_service_info: Some(BackupServiceInfo { public_key: Ed25519PublicKey([51, 124, 141, 94, 252, 206, 8, 1, 108, 142, 203, 70, 244, 72, 22, 45, 95, 166, 91, 27, 9, 6, 129, 76, 196, 189, 190, 111, 140, 209, 167, 171]) }), active_migration: false }


def submit_backup_service_info(cluster: MpcCluster, node_id: int):
    """
    Submits the backup service information to the contract
    """

    home_dir = os.path.join(MPC_REPO_DIR / "pytest" / "backup-service")
    json_path = os.path.join(home_dir, "secrets.json")
    with open(json_path, "r") as f:
        data = json.load(f)

    priv_bytes = bytes(data["p2p_private_key"])

    # 3. Derive public key
    sk = SigningKey(priv_bytes)
    pk_bytes = sk.verify_key.encode()

    # Convert to base58
    pk_b58 = base58.b58encode(pk_bytes).decode()

    near_pubkey = f"ed25519:{pk_b58}"
    # pk = sk.verify_key

    ## 4. Print results
    # print("Private key bytes (len={}):".format(len(priv_bytes)), priv_bytes)
    # print("Public key bytes (len={}):".format(len(pk.encode())), list(pk.encode()))
    # print("Public key hex:", pk.encode().hex())
    # pk_near = "ed25519:" + pk.encode().hex()
    # pk_b58 = base58.b58encode(pk_bytes).decode()
    # near_pk =
    # print("Public key (NEAR format):", pk_near)

    backup_service_info = BackupServiceInfo(near_pubkey)
    res = cluster.register_backup_service_info(
        node_id, backup_service_info=backup_service_info
    )
    print(res)
    return res


# step 1: read public key from contract
# step 2: submit to contract


def test_migration_service():
    """
    Tests single-domain key generation and resharing.

    The test starts with 2 nodes and one domain, performs key generation, and verifies
    that the attempt ID is incremented correctly.

    It performs multiple rounds of resharing while changing the participant set.

    Signature requests are sent after each resharing to verify liveness.
    """

    home_dir = os.path.join(MPC_REPO_DIR / "pytest" / "backup-service")
    os.makedirs(home_dir, exist_ok=True)
    set_up_backup_service(home_dir=home_dir)

    cluster, mpc_nodes = shared.start_cluster_with_mpc(
        2, 4, 1, load_mpc_contract(), for_migration=True
    )
    # start with 2 nodes
    cluster.init_cluster(participants=mpc_nodes[:3], threshold=2)
    cluster.send_and_await_ckd_requests(1)
    cluster.send_and_await_signature_requests(1)

    # contract_state = self.contract_state()
    #       assert isinstance(contract_state.protocol_state, RunningProtocolState)
    #        assert len(
    #            contract_state.protocol_state.parameters.participants.participants
    #        ) == len(self.mpc_nodes)
    #        for p in self.mpc_nodes:
    #            assert contract_state.protocol_state.parameters.participants.is_participant(
    #                p.account_id()
    #            )
    #            p_info: Participant = (
    #                contract_state.protocol_state.parameters.participants.by_account(
    #                    p.account_id()
    #                )
    #            )
    #            assert p.p2p_public_key == p_info.sign_pk
    # 1. call backup service to GET shares

    _ = submit_backup_service_info(cluster, 0)

    ## wait until it appears in the webendpoint of node
    time.sleep(10)
    contract_state = cluster.get_contract_state()
    json_path = os.path.join(home_dir, "contract_state.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(contract_state, f, indent=2, ensure_ascii=False)

    print(f"Saved contract state to: {json_path}")
    call_backup_service(mpc_node=mpc_nodes[0], home_dir=home_dir)

    time.sleep(2000)
    # url = mpc_nodes[0].url
    # p2p_key = mpc_nodes[0].p2p_public_key
    # backup_encryption_key = mpc_nodes[0].backup_key
    # home_dir = os.path.join(MPC_REPO_DIR / "pytest" / "backup-service")
    # os.makedirs(home_dir, exist_ok=True)
    # cmd = (
    #    BACKUP_SERVICE_BINARY_PATH,
    #    "--home-dir",
    #    home_dir,
    #    "get-keyshares",
    #    "--mpc-node-url",
    #    url,
    #    "--mpc-node-p2p-key",
    #    p2p_key,
    #    "--backup-encryption-key-hex",
    #    backup_encryption_key.hex(),
    # )
    # print(f"running command:\n{cmd}\n")
    # subprocess.run(cmd)
    # 2. start migration in the contracts

    # 3. call backup service to POST shares

    # 4. ensure migration succeeded by checking the contract values

    ## two new nodes join, increase threshold
    # cluster.do_resharing(
    #    new_participants=mpc_nodes[:4], new_threshold=3, prospective_epoch_id=1
    # )
    # cluster.update_participant_status()
    # cluster.send_and_await_signature_requests(1)
    # cluster.send_and_await_ckd_requests(1)

    # kicked_out_node = mpc_nodes[0]
    # new_participants = mpc_nodes[1:]
    # cluster.do_resharing(
    #    new_participants=new_participants, new_threshold=3, prospective_epoch_id=2
    # )
    # cluster.update_participant_status()
    # cluster.send_and_await_signature_requests(1)

    ## restart node so it re-submits a TEE attestation
    # kicked_out_node.restart()

    # cluster.do_resharing(
    #    new_participants=mpc_nodes,
    #    new_threshold=3,
    #    prospective_epoch_id=3,
    #    wait_for_running=False,
    # )

    # assert cluster.wait_for_state(ProtocolState.RUNNING), "failed to start running"
    # cluster.update_participant_status()
    # cluster.send_and_await_ckd_requests(1)
    # cluster.send_and_await_signature_requests(1)

    ## test for multiple attemps:

    # mpc_nodes[0].reserve_key_event_attempt(4, 0, 0)
    # mpc_nodes[0].reserve_key_event_attempt(4, 0, 1)
    # cluster.do_resharing(
    #    new_participants=mpc_nodes, new_threshold=4, prospective_epoch_id=4
    # )
    # cluster.update_participant_status()
    # assert cluster.contract_state().keyset().keyset[0].attempt_id == 2
    # cluster.send_and_await_signature_requests(1)
    # cluster.send_and_await_ckd_requests(1)
