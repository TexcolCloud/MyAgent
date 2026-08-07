# Personal Agent

This context models how one trusted Operator delegates work to software Agents while retaining authority over sensitive actions.

## Language

**Operator**:
The sole trusted person who owns the personal Agent environment and makes approval decisions.
_Avoid_: Tenant, account, end user

**Personal Agent**:
A software collaborator that acts on behalf of the Operator within defined capabilities and permissions.
_Avoid_: Chatbot, tenant bot

**Workspace**:
The explicitly configured filesystem root in which a Personal Agent's file and command Tools operate; multiple Agents share one only by deliberate configuration.
_Avoid_: Repository, current working directory

**Delegation**:
A bounded request from one Personal Agent to another, represented by a child Run with explicitly selected context and a returned result.
_Avoid_: Shared Session, Agent switch

**Run**:
A tracked attempt by one or more Personal Agents to fulfill a single Operator request; it may pause for a decision and continue later.
_Avoid_: HTTP request, job

**Run Event**:
A durable, ordered record of a Run's state change or observable output.
_Avoid_: Log line, transient notification

**Session**:
The continuing conversation state owned by one Personal Agent; a Session may contain many Runs.
_Avoid_: Run, user

**Session Summary**:
A derived, replaceable compression of older Session history used to fit model context without becoming Memory or replacing the canonical record.
_Avoid_: Memory, transcript deletion

**Session Key**:
An external label that identifies a Session within one Personal Agent's namespace; Session identity is the pair of Agent identity and Session Key.
_Avoid_: Run ID, global conversation ID

**Skill**:
An instruction document that describes specialized knowledge or a workflow available to a Personal Agent without granting execution authority.
_Avoid_: Tool, executable plugin

**Tool**:
A named, policy-governed capability that a Personal Agent may request to use.
_Avoid_: Skill, unrestricted function

**Tool Call**:
A Personal Agent's proposal to invoke one named capability with an exact set of arguments.
_Avoid_: Skill, blanket permission

**Tool Policy**:
A deterministic rule set that decides whether a Tool Call is allowed, denied, or requires Approval.
_Avoid_: Model judgment, Tool implementation

**Approval**:
The Operator's one-time decision to authorize or deny one exact Tool Call; changing its arguments requires a new decision.
_Avoid_: Confirmation, blanket permission

**Knowledge Base**:
Operator-managed source material that can be retrieved to ground a Personal Agent's work.
_Avoid_: Memory, Session history

**Collection**:
A named set of Knowledge Base sources that can be assigned to one or more Personal Agents for retrieval.
_Avoid_: Workspace, Memory namespace

**Memory**:
A durable and revisable fact, preference, or learned observation derived from the Operator's interactions and owned by one Personal Agent.
_Avoid_: Knowledge Base, transcript, Session history

**Channel**:
An external communication surface that translates platform messages into Runs and delivers their results.
_Avoid_: Session, Personal Agent

**Schedule**:
A persistent time-based rule that submits a predefined request to a Personal Agent.
_Avoid_: Run, operating-system timer
