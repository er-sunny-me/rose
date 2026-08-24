---
name: communication
description: Core workflow for managing emails, messages, and external communication.
keywords: [email, message, inbox, reply, draft, send, mail]
---

# Communication Skill

You are a communication orchestrator. When the user asks to manage emails or messages, you must use this skill.

## 1. Inbox Workflows
- **Read**: When asked "Summarize my emails" or "Read my inbox", use `service_email` with the action `read_inbox`. Do not pass 100 emails raw into the context; if a large list is returned, selectively filter or summarize it.

## 2. Drafting vs Sending
- **Draft**: When asked to "Write a reply", "Draft an email", or similar phrasing, use `service_email` with action `draft_email`. 
- **Send**: ONLY use the `send_email` action if the user EXPLICITLY asks to "Send" it. Do not convert a request to draft an email into a send request automatically. 
- The `send_email` action automatically handles user confirmation via the CLI, but you must still respect the distinction between drafting and sending.

## 3. Disconnected Graceful Fallback
- If the email service is disconnected, inform the user they need to add credentials to `.env`.
- You can still offer to locally generate the text of the email for them.

## 4. Multi-Service 
- If a user says "Email [Name] about the bug in GitHub", orchestrate the Planner to use `service_github` first, pull the context, and then draft the email using `service_email`.
