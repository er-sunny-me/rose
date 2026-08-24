---
name: system
description: Check system information, CPU, RAM, and OS stats.
version: 1.0.0
category: system
keywords:
  - cpu
  - ram
  - memory
  - os
  - system
  - hardware
capabilities:
  - inspect_hardware
  - check_resources
tools:
  - execute_command
---

# System Skill

## Purpose
Use this skill when the user asks about the performance, load, or hardware details of their computer.

## Rules
- Use Windows commands (like powershell Get-Process, Get-WmiObject, wmic) to inspect the system via `execute_command`.
- Summarize the metrics clearly.
