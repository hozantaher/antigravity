# Operator Upgrade Guide

This document describes how to upgrade `anti-trace-relay` with minimal disruption and no message loss.

---

## 1. Pre-upgrade checklist

**Check queue depth.**

```sh
curl -s http://localhost:<PORT>/v1/status | jq .queue_depth
```

Ideally wait until `queue_depth` reaches `0`. If the queue is non-empty, note the current depth — you will verify it matches after restart.

**Confirm bridge reachability.**

```sh
curl -s http://localhost:<PORT>/v1/health
```

The response should indicate the bridge target is reachable. Do not upgrade while the bridge is unreachable; in-flight envelopes will be retried automatically after restart, but a broken bridge means delivery will stall on both sides of the upgrade window.

**Locate the queue file.**

The encrypted queue file path is set via the `--queue-file` flag (or the `QUEUE_FILE` environment variable). Check the running unit file or container definition:

```sh
systemctl cat anti-trace-relay | grep queue-file
# or
docker inspect <container> | grep queue-file
```

Default path when the flag is omitted: `./relay-queue.json` relative to the working directory.

**Optional: back up the queue file.**

```sh
cp /path/to/relay-queue.json /path/to/relay-queue.json.bak
```

The queue file is AES-256-GCM encrypted. A backup is useful if the binary swap fails and you need to roll back.

---

## 2. Upgrade procedure

**Stop the service.**

```sh
systemctl stop anti-trace-relay
# or send SIGTERM to the process directly:
kill -TERM <PID>
```

**Wait for graceful drain.**

The relay drains in-flight HTTP submissions before exiting. Watch the logs for the shutdown-complete message:

```
level=info msg="shutdown complete"
```

If the process does not exit within 30 seconds, check for stuck connections before force-killing it.

**Replace the binary.**

```sh
# Example: replace via a package manager, scp, or artifact download.
cp /tmp/anti-trace-relay-new /usr/local/bin/anti-trace-relay
chmod +x /usr/local/bin/anti-trace-relay
```

**Start the service.**

```sh
systemctl start anti-trace-relay
```

**Verify queue depth is restored.**

```sh
curl -s http://localhost:<PORT>/v1/status | jq .queue_depth
```

The depth should match the value you recorded in the pre-upgrade checklist. Envelopes persisted in the queue file are loaded automatically at startup — no manual intervention is needed.

**Verify bridge reconnection.**

```sh
curl -s http://localhost:<PORT>/v1/health
```

Both the relay and the bridge target should report healthy.

---

## 3. What happens to in-flight messages

- **On SIGTERM**: the relay finishes handling any HTTP requests that are mid-flight (submitter has connected but not yet received a response) before exiting. New connections are rejected once SIGTERM is received.
- **Persisted queue**: the encrypted queue file is written atomically after every `Schedule` call. Any envelope that received an `accepted` response from the API is guaranteed to be in the queue file on disk before that response was sent.
- **Startup recovery**: `NewScheduler` reads the queue file on init. All scheduled envelopes present at shutdown are picked up immediately at next startup and will be delivered according to their original scheduled time (or immediately, if that time has already passed).
- **No manual replay needed**: the operator does not need to replay or re-inject messages after a normal restart.

---

## 4. Rollback

**Stop the new binary.**

```sh
systemctl stop anti-trace-relay
```

**Restore the previous binary.**

```sh
cp /usr/local/bin/anti-trace-relay.bak /usr/local/bin/anti-trace-relay
chmod +x /usr/local/bin/anti-trace-relay
```

**Queue file compatibility.**

The queue file format (AES-256-GCM encrypted JSON) is stable across releases. The old binary can read a queue file written by the new binary, provided the encryption key (`--queue-key`) is unchanged.

**If the queue file is corrupted:**

The service starts with an empty queue. Envelopes stored in the corrupted file are unrecoverable. If you took a pre-upgrade backup, restore it before starting:

```sh
cp /path/to/relay-queue.json.bak /path/to/relay-queue.json
systemctl start anti-trace-relay
```

---

## 5. Zero-downtime considerations

This service is designed for single-node MVP deployment. During the binary swap there is a brief window (typically under one second) where the port is not accepting connections.

| Scenario | Behaviour |
|---|---|
| Submitter sends request exactly during SIGTERM drain window | Request is completed normally if it arrived before SIGTERM |
| Submitter connects during binary-swap gap | TCP connection refused; submitter should retry |
| Bridge unreachable at startup | Relay starts and queues envelopes; delivery resumes when bridge becomes reachable |
| Queue file missing at startup | Relay starts with empty queue; previously persisted envelopes are lost |

For high-availability requirements beyond MVP, run two instances behind a load balancer and perform rolling restarts, ensuring the shared queue file is on a network volume accessible to both nodes.
