# Use a declarative, default-deny Tool Policy

Ordered Tool Policy rules match Agent identity, Tool name, and argument constraints, with the first match deciding `allow`, `ask`, or `deny`; unmatched Tool Calls are denied. Policy evaluation is deterministic and outside the model so permissions are testable, auditable, and impossible to grant through prompt instructions alone.
