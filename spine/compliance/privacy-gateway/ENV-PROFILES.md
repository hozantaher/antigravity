# Environment Profiles

## Purpose

This is the shortest navigation guide for ready-to-use environment profile snippets.

Use it when you need to answer:

- which profile file to start from
- which retention posture matches the current environment
- where to copy values from into a real deployment env file

## Available Profiles

### Dev

File:

- [.env.profile.dev.example](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.profile.dev.example)

Use when:

- the service runs locally
- debugging and state visibility matter most

### Small Team

File:

- [.env.profile.small-team.example](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.profile.small-team.example)

Use when:

- a small internal team shares the service
- you want bounded growth without a very aggressive privacy posture

### Privacy-Strict

File:

- [.env.profile.privacy-strict.example](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.profile.privacy-strict.example)

Use when:

- data minimization is the main operating priority
- shorter investigation windows are acceptable

### Investigation Window

File:

- [.env.profile.investigation.example](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/.env.profile.investigation.example)

Use when:

- you are debugging an incident
- you temporarily want a longer evidence window

## How To Apply

Recommended workflow:

1. choose one profile file
2. copy its retention values into the real environment file for that deployment
3. keep only one active retention posture per environment
4. record the choice in operator notes or deployment history

## Important Notes

- these files only cover retention controls
- they do not replace the full runtime configuration
- `0` means pruning is disabled for that subsystem
- pruning is still activity-driven, not scheduler-driven
- inbox and outbox retention are now included alongside audit, submission, identity-link, and IMAP cursor settings

## Cross-References

For reasoning and tradeoffs, see:

- [RETENTION-CONFIGURATION-COOKBOOK.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/RETENTION-CONFIGURATION-COOKBOOK.md)
- [DATA-RETENTION-NOTES.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/DATA-RETENTION-NOTES.md)
- [OPERATOR-GUIDE.md](/Users/messingtomas/Taher/hozan-taher/services/privacy-gateway/OPERATOR-GUIDE.md)
