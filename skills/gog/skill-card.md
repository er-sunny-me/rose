## Description: <br>
Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[steipete](https://clawhub.ai/user/steipete) <br>

### License/Terms of Use: <br>


## Use Case: <br>
Developers and operators use this skill to set up and run the gog CLI for Google Workspace tasks across Gmail, Calendar, Drive, Contacts, Sheets, and Docs. It provides command examples for authentication, search, send, export, and spreadsheet operations. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: OAuth access can expose or modify Gmail, Calendar, Drive, Contacts, Sheets, and Docs data if granted too broadly or used with an untrusted CLI. <br>
Mitigation: Install only if the gog CLI is trusted, grant only the Google Workspace services needed, and review commands before sending email or modifying Workspace data. <br>
Risk: OAuth client secrets and command output can contain sensitive information. <br>
Mitigation: Keep OAuth client secrets out of shared folders and repositories, and avoid logging sensitive JSON output. <br>


## Reference(s): <br>
- [Gog CLI homepage](https://gogcli.sh) <br>
- [ClawHub skill page](https://clawhub.ai/steipete/skills/gog) <br>


## Skill Output: <br>
**Output Type(s):** [guidance, shell commands, configuration] <br>
**Output Format:** [Markdown with inline shell command examples] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Commands may emit JSON when gog is run with --json.] <br>

## Skill Version(s): <br>
1.0.0 (source: ClawHub release evidence) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
