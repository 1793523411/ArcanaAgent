---
name: novelty-driven-planning
description: Apply principles from "Why Greatness Cannot Be Planned" to transform goal-driven planning into exploration-driven innovation. This skill should be used when users are planning projects, managing innovation, making architectural decisions, or feeling constrained by rigid objectives. It helps identify objective traps, generate novel exploration directions (stepping stones), and track discovery journeys.
---

# Novelty-Driven Planning

## Overview

Transform rigid goal-oriented planning into exploration-driven innovation by applying principles from "Why Greatness Cannot Be Planned: The Myth of the Objective" by Kenneth O. Stanley and Joel Lehman. This skill helps identify when objectives become constraints, suggests novel exploration directions (stepping stones), and tracks the discovery journey to reveal unexpected value paths.

## When to Use This Skill

Invoke this skill when users:
- Present detailed project plans or roadmaps that seem overly rigid
- Express frustration with not achieving predefined goals
- Ask for help with innovation, creativity, or breakthrough thinking
- Are making architectural or technical decisions and want to explore alternatives
- Want to refactor code or evolve systems but feel constrained by current goals
- Use phrases like "我想规划..." (I want to plan), "创新" (innovation), "探索" (explore), "重构" (refactor)

## Core Capabilities

### 1. Identify Objective Traps

Analyze user's plans or goals to identify signs of objective traps:

**Symptoms of objective traps:**
- Goals that are too specific and distant (e.g., "Build a system that handles 1M users in 6 months")
- Plans that assume a linear path to success
- Rigid milestones that leave no room for discovery
- Focus on metrics rather than learning
- Dismissal of "interesting but off-track" ideas

**Analysis approach:**
- Read the user's plan or goal statement
- Identify assumptions about the path to success
- Point out where rigidity might block discovery
- Highlight interesting directions that might be dismissed as "off-goal"

**Output format:**
```markdown
## 🎯 Objective Trap Analysis

### Current Goal Structure
[Summarize the user's stated goals]

### Potential Constraints
1. **[Constraint name]**: [How this goal might limit exploration]
2. **[Constraint name]**: [What interesting paths might be blocked]

### Dismissed Opportunities
- [Interesting directions that seem "off-track" but might be valuable stepping stones]
```

### 2. Generate Exploration Directions (Stepping Stones)

Based on current state, suggest novel and interesting directions to explore rather than direct paths to goals.

**Principles for generating stepping stones:**
- Focus on what's interesting and novel from the current position
- Don't justify stepping stones by their distance to a goal
- Prioritize learning and discovery over achievement
- Suggest directions that open up new possibilities
- Value "interestingness" over "usefulness"

**Generation approach:**
1. Assess current state (what has been built, learned, or explored)
2. Identify adjacent interesting possibilities (not goal-directed paths)
3. For each possibility, explain what makes it novel or intriguing
4. Avoid justifying suggestions by how they help reach the stated goal

**Output format:**
```markdown
## 🧭 Exploration Directions (Stepping Stones)

### Current Position
[Brief summary of where the user/project is now]

### Interesting Directions to Explore

#### 1. [Direction Name]
**Why it's interesting**: [What makes this novel or intriguing]
**What you might discover**: [Potential learnings, not goal achievement]
**Next small step**: [Concrete action to explore this direction]

#### 2. [Direction Name]
**Why it's interesting**: [Novelty factor]
**What you might discover**: [Learning opportunities]
**Next small step**: [Concrete exploration action]

[Continue for 3-5 directions]

### 🎲 Wild Card
[One highly novel direction that seems "crazy" but might lead somewhere unexpected]
```

### 3. Track Exploration Journey

Help users document their exploration journey to identify patterns and unexpected value paths. Use the `<SKILL_PATH>/scripts/journey_tracker.py` script to maintain a structured log.

**Usage:**
```bash
# Add a new stepping stone discovery
python <SKILL_PATH>/scripts/journey_tracker.py add \
  --stone "Implemented simple caching layer" \
  --discovery "Realized our data access patterns are highly predictable" \
  --novelty 7 \
  --opens "Could explore predictive prefetching"

# View journey timeline
python <SKILL_PATH>/scripts/journey_tracker.py view

# Analyze journey for patterns
python <SKILL_PATH>/scripts/journey_tracker.py analyze
```

**Manual tracking approach (if script unavailable):**
Maintain a journey log in markdown format using the template in `references/journey_template.md`.

### 4. Evaluate Novelty Over Goal-Distance

When evaluating options, assess based on novelty and interestingness rather than proximity to goals.

**Novelty evaluation criteria:**
- **Unexplored territory** (0-10): How much is unknown about this direction?
- **Potential for surprise** (0-10): Likelihood of unexpected discoveries?
- **Opens new possibilities** (0-10): Does it create new adjacent possibilities?
- **Intrinsic interest** (0-10): Is it interesting for its own sake?

**Evaluation approach:**
1. For each option presented, score on the four criteria above
2. Calculate novelty score (average of four criteria)
3. Rank by novelty score, not by goal-distance
4. Recommend the most novel options for exploration

**Output format:**
```markdown
## 📊 Novelty Evaluation

| Option | Unexplored | Surprise | Opens Doors | Interest | Novelty Score |
|--------|-----------|----------|-------------|----------|---------------|
| [A]    | 8         | 7        | 9           | 8        | 8.0           |
| [B]    | 5         | 6        | 5           | 6        | 5.5           |

### Recommendation
Explore **[Option A]** first due to its high novelty score. It opens the most new possibilities and has significant potential for surprising discoveries.
```

## Workflow

### For Project Planning

1. **Receive user's plan** → Identify objective traps (Capability 1)
2. **Analyze constraints** → Generate exploration directions (Capability 2)
3. **User explores direction** → Track discoveries (Capability 3)
4. **Repeat** → From new position, generate new stepping stones

### For Technical Decisions

1. **Receive options/approaches** → Evaluate by novelty (Capability 4)
2. **Recommend novel direction** → Explain what makes it interesting
3. **User implements** → Track learnings (Capability 3)
4. **Discover new possibilities** → Generate next stepping stones (Capability 2)

### For Architectural Evolution

1. **Analyze current architecture** → Identify interesting refactoring directions
2. **Generate small evolutionary steps** → Focus on learning, not end-state
3. **Track architectural discoveries** → Document what each step revealed
4. **Let architecture emerge** → Avoid rigid target architecture

## Key Principles to Emphasize

Throughout all interactions, reinforce these principles:

1. **Objectives can deceive**: Long-term specific goals often lead us away from breakthrough discoveries
2. **Stepping stones over milestones**: Value interesting intermediate steps over progress toward goals
3. **Novelty as compass**: Use interestingness and novelty as navigation, not goal-distance
4. **Non-objective search**: Sometimes the best way forward is to not aim for the destination
5. **Serendipity is systematic**: Create conditions for discovery by exploring interesting directions

## Resources

### references/

- `references/theoretical_framework.md` - Deep dive into the book's core concepts, research background, and philosophical foundations
- `references/evaluation_criteria.md` - Detailed rubrics for assessing novelty, identifying stepping stones, and recognizing objective traps
- `references/journey_template.md` - Template for manually tracking exploration journeys

### scripts/

- `<SKILL_PATH>/scripts/journey_tracker.py` - Python script to log, view, and analyze exploration journeys with structured data

Load reference files when deeper theoretical understanding is needed or when users want to learn more about the principles behind the recommendations.
