# Treat Skills as on-demand instructions rather than executable plugins

The runtime indexes Skill metadata only from explicitly configured roots, restricts each Personal Agent to its declared Skill set, presents eligible summaries, and loads full `SKILL.md` instructions only when selected. A Skill grants no execution authority of its own, keeping instruction discovery separate from governed Tool Calls, preventing accidental files from becoming instructions, and avoiding unconditional prompt growth.
