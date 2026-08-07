# Define Agents in files with explicit Workspaces

Each Personal Agent is defined by versionable files that declare its prompt, model settings, Skill allowlist, Tool Policy, and Workspace. Workspaces are isolated by configuration unless multiple Agents deliberately reference the same root, keeping configuration reviewable without forbidding intentional file-level collaboration.
