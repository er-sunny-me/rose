# Agent Platform

Welcome to the **Agent Platform** - a fully integrated, zero-trust, multi-agent AI runtime.

## Overview
This platform brings together 30 phases of advanced architectural development into a single, cohesive engine capable of autonomous task execution, federated delegation, predictive simulations, and multi-modal interactions.

## Core Capabilities
- **Gemini Live & Text Interaction**: Real-time voice and text chat interfaces.
- **Agent Core & Planner**: Hierarchical task breakdown and Supervisor orchestration.
- **World Model & Goals**: Long-horizon task management and causal reasoning.
- **Zero-Trust Security**: Deep Policy-as-Code engine that intercepts and simulates destructive actions.
- **Transactions & Event Sourcing**: Guaranteed rollback and reconciliation upon failure.
- **Federated Agent Mesh**: Secure delegation across isolated trust domains.
- **Observability**: Live metrics, SLO tracking, Error Budgets, and Cost analysis.

## Getting Started

### 1. Configuration
Create a `.env` file in the root directory:
```bash
GEMINI_API_KEY=your_api_key_here
```

### 2. Startup Modes
Run the interactive CLI:
```bash
npm run dev
```

Run in Headless Server mode:
```bash
npm run dev -- --server
```

### 3. Usage
Interact with the agent using text or use `/voice` to initiate Gemini Live voice interactions. Check out `/help` for a full list of CLI commands like `/diagnostics`, `/observability`, and `/tasks`.

## Documentation
For deep dives into the system architecture, please see:
- [Architecture](ARCHITECTURE.md)
- [Security](SECURITY.md)
- [Configuration](CONFIGURATION.md)
- [CLI Reference](CLI.md)
