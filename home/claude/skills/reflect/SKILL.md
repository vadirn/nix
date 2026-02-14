---
name: reflect
description: Post-conversation retrospective that reviews the current conversation for mistakes, friction, and improvements. Also audits any skills used in the chat. Trigger when user types "reflect" or when you notice repeated corrections, double clarifications, or signs of frustration.
---

# Reflect

Post-conversation retrospective. Reviews this chat, identifies problems, proposes fixes.

## Trigger

- User types "reflect"
- Proactive: suggest "reflect" when you notice the user corrected you, clarified the same thing twice, or seems frustrated

## Process

### 1. Chat Review

Scan the full conversation. For each exchange, note:
- **Mistakes**: wrong outputs, hallucinations, misunderstood intent
- **Friction**: extra clarifications needed, slow convergence, verbose responses
- **Unclear outputs**: ambiguous answers, missing context, format mismatches

### 2. Improvement List

Produce a short numbered list of concrete improvements. Each item must be actionable — either a behavior change Claude can remember, or a skill/workflow fix.

Format:
```
1. [Category] Description — what to do differently
```

Categories: `Mistake`, `Friction`, `Unclear`, `Workflow`, `Skill`

### 3. Memory Prompt

Ask: "Which of these should I remember for future chats?" Then save confirmed items to memory.

### 4. Skill Audit

If any skills were used in this chat, check each one:

**Self-check injection** — if the skill lacks success criteria and a verification loop:
- Add success criteria at the top of the skill (clear, measurable)
- Add an instruction at the bottom: "Before presenting output, verify all success criteria are met. If not, iterate (max 5 times)."

**Token efficiency** — scan for redundant instructions, overly verbose examples, or duplicated content. Propose cuts that save tokens without losing clarity or function.

**Other improvements** — other changes that improve results based on this chat.

Present proposed skill changes and ask for confirmation before applying.

### 5. Pattern Detection

If you notice the user repeatedly asks for similar tasks in this conversation (or past chats), suggest creating a reusable skill. Ask for confirmation before proceeding.

## Output Format

```
## Reflect

### What happened
[1-2 sentence summary of the chat]

### Issues found
1. [Category] ...
2. [Category] ...

### Skill audit
[Only if skills were used. List skill name + proposed changes.]

### Patterns noticed
[Only if repetitive tasks detected. Suggest new skill.]

### Remember?
Which of the above should I store for future chats?
```
