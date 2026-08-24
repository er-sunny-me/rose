---
name: terminal
description: Execute general shell commands and manage files.
version: 1.0.0
category: system
keywords:
  - terminal
  - shell
  - file
  - folder
  - directory
  - command
capabilities:
  - run_shell
  - manage_files
tools:
  - execute_command
---

# Terminal Skill

## Purpose
Use this skill to execute arbitrary shell scripts, manage directories (create/move/delete folders), or inspect the filesystem.

## Rules
- When the user asks to manage files or folders, use standard shell commands via `execute_command`.
- Always double check the current working directory before deleting or moving files.
- Be extremely cautious with recursive deletions.
