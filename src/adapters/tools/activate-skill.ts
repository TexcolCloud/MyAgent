import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import type { ToolDefinition } from "../../ports/tool.js";

const activateSkillSchema = z.strictObject({
  skillName: z.string().min(1),
});

type ActivateSkillArguments = {
  skillName: string;
};

export const activateSkillTool: ToolDefinition<ActivateSkillArguments> = {
  name: "activate_skill",
  effect: "internal",

  async parseAndNormalize(raw, context) {
    const parsed = activateSkillSchema.parse(raw);
    if (!context.revision.skills.some((skill) => skill.name === parsed.skillName)) {
      throw new DomainError("skill_not_available");
    }
    return { arguments: parsed, policyFacts: {} };
  },

  async execute(args, context) {
    context.signal.throwIfAborted();
    context.activateSkill(args.skillName);
    const content = { skillName: args.skillName, activated: true };
    return {
      ok: true,
      summary: `Activated Skill ${args.skillName}.`,
      content,
      capturedBytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
      truncated: false,
    };
  },
};
