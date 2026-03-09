# AIMA Project Rules

## What is AIMA

**AIMA** = Artificial Intelligence: A Minded Architecture

An open-source framework for building autonomous cognitive agents using a neuroscience-inspired five-brain architecture (Limbic / Cortex / Brainstem / Amygdala / DMN).

## Language Convention
- All code, comments, variable names, API identifiers: **English**
- All documentation (`docs/`, `research/`): **Chinese (中文)**
- Git commit messages: **English**

## First Principles
Apply in order before adding anything:
1. **Question the requirement** — does this need to exist?
2. **Delete** — remove before adding
3. **Simplify** — only after deleting
4. **Accelerate** — speed up what remains
5. **Automate** — last step only

Occam's Razor: minimum complexity for the current problem.

## Architecture Principles
- Five brains are fixed core: Limbic / Cortex / Brainstem / Amygdala / DMN
- Loop is infrastructure — no business logic inside
- Cognition layer = Skill (Markdown), not code
- Brain Event Bus is the only audit interface — AIMA does not implement audit internally
- Cognitive Workspace (Thread + Slot) replaces explicit delegation

## Open Source Guidelines
- Public API surface must be stable and well-documented before tagging releases
- No vendor-specific dependencies in core (LLM providers are pluggable)
- Breaking changes require major version bump
