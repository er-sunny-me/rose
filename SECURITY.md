# Security & Policy Architecture

## Zero-Trust Design

The Agent Platform implements a strict Zero-Trust policy engine. The AI Model is given **no inherent authority** to mutate the system state directly.

All intent expressed by the Planner or Tool Executor must pass through the `SecurityEngine`.

### Key Tenets
- **Data Classification**: Operations touching `SECRET` or `CONFIDENTIAL` data are blocked or require interactive `Approval`.
- **Capability Scoping**: A `Federated Agent` cannot inherit the host's trust domain; it operates strictly inside an isolated capability scope.
- **Transactions**: Tools modifying state are wrapped in a `Transaction`. If verification fails or a policy violation occurs mid-execution, the entire state change is rolled back.

### The Attack Chain
1. Untrusted content injected via Browser/Web search.
2. The Agent Model gets confused and attempts to call `filesystem.write('/etc/passwd')`.
3. The `CapabilityRouter` resolves the tool and requests a lease.
4. The `PolicyStore` identifies a restricted filesystem operation.
5. The `SecurityEngine` blocks the call and audits the failure.
6. The Agent Model is fed an execution failure and continues without side effects.
