#!/usr/bin/env python3
"""
Tests migration service (migrating a node).
Starts 2 nodes, have node #1 migrate to node #3
At every step we check that signatures can still be produced.
"""

import pathlib
import sys

import pytest

from common_lib.contract_state import ProtocolState

sys.path.append(str(pathlib.Path(__file__).resolve().parents[1]))
from common_lib import shared
from common_lib.contracts import load_mpc_contract


def test_mirgation_service():
    """
    Tests single-domain key generation and resharing.

    The test starts with 2 nodes and one domain, performs key generation, and verifies
    that the attempt ID is incremented correctly.

    It performs multiple rounds of resharing while changing the participant set.

    Signature requests are sent after each resharing to verify liveness.
    """
    cluster, mpc_nodes = shared.start_cluster_with_mpc(2, 4, 1, load_mpc_contract())
    mpc_nodes[0].reserve_key_event_attempt(0, 0, 0)
    mpc_nodes[0].reserve_key_event_attempt(0, 0, 1)
    # start with 2 nodes
    cluster.init_cluster(participants=mpc_nodes[:2], threshold=2)
    assert cluster.contract_state().keyset().keyset[0].attempt_id == 2
    cluster.send_and_await_ckd_requests(1)
    cluster.send_and_await_signature_requests(1)

    # two new nodes join, increase threshold
    cluster.do_resharing(
        new_participants=mpc_nodes[:4], new_threshold=3, prospective_epoch_id=1
    )
    cluster.update_participant_status()
    cluster.send_and_await_signature_requests(1)
    cluster.send_and_await_ckd_requests(1)

    kicked_out_node = mpc_nodes[0]
    new_participants = mpc_nodes[1:]
    cluster.do_resharing(
        new_participants=new_participants, new_threshold=3, prospective_epoch_id=2
    )
    cluster.update_participant_status()
    cluster.send_and_await_signature_requests(1)

    # restart node so it re-submits a TEE attestation
    kicked_out_node.restart()

    cluster.do_resharing(
        new_participants=mpc_nodes,
        new_threshold=3,
        prospective_epoch_id=3,
        wait_for_running=False,
    )

    assert cluster.wait_for_state(ProtocolState.RUNNING), "failed to start running"
    cluster.update_participant_status()
    cluster.send_and_await_ckd_requests(1)
    cluster.send_and_await_signature_requests(1)

    # test for multiple attemps:

    mpc_nodes[0].reserve_key_event_attempt(4, 0, 0)
    mpc_nodes[0].reserve_key_event_attempt(4, 0, 1)
    cluster.do_resharing(
        new_participants=mpc_nodes, new_threshold=4, prospective_epoch_id=4
    )
    cluster.update_participant_status()
    assert cluster.contract_state().keyset().keyset[0].attempt_id == 2
    cluster.send_and_await_signature_requests(1)
    cluster.send_and_await_ckd_requests(1)
