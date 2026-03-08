# Evaluation Criteria and Rubrics

This document provides detailed rubrics for assessing novelty, identifying stepping stones, recognizing objective traps, and evaluating exploration directions.

## 1. Novelty Assessment Rubric

Use this rubric to evaluate the novelty of ideas, directions, or approaches on a 0-10 scale across four dimensions.

### Dimension 1: Unexplored Territory (0-10)

**Question**: How much is unknown about this direction?

| Score | Description | Indicators |
|-------|-------------|------------|
| 0-2 | Well-trodden path | - Extensively documented<br>- Standard practice in the field<br>- Multiple established solutions exist<br>- No uncertainty about outcomes |
| 3-4 | Somewhat familiar | - Some documentation exists<br>- A few known implementations<br>- General approach is understood<br>- Minor uncertainties remain |
| 5-6 | Partially explored | - Limited documentation<br>- Few implementations to reference<br>- Approach is conceptually understood but details unclear<br>- Moderate uncertainty |
| 7-8 | Largely unexplored | - Minimal documentation<br>- Very few (if any) implementations<br>- Significant unknowns about approach<br>- High uncertainty about outcomes |
| 9-10 | Uncharted territory | - No documentation found<br>- No known implementations<br>- Fundamental unknowns<br>- Extreme uncertainty, but that's exciting |

### Dimension 2: Potential for Surprise (0-10)

**Question**: How likely are unexpected discoveries?

| Score | Description | Indicators |
|-------|-------------|------------|
| 0-2 | Predictable | - Outcomes are well-understood<br>- No history of surprises in this area<br>- Linear, straightforward path<br>- "We know exactly what will happen" |
| 3-4 | Minor surprises possible | - Mostly predictable with small variations<br>- Occasional unexpected findings in similar work<br>- Some room for discovery<br>- "Probably what we expect, maybe a few tweaks" |
| 5-6 | Moderate surprise potential | - Several possible outcomes<br>- History of unexpected findings in related areas<br>- Non-linear dynamics<br>- "Could go a few different ways" |
| 7-8 | High surprise potential | - Many possible outcomes<br>- Strong history of surprises in this domain<br>- Complex interactions<br>- "We might discover something unexpected" |
| 9-10 | Extreme surprise potential | - Outcomes are highly unpredictable<br>- Domain known for breakthrough discoveries<br>- Emergent properties likely<br>- "We have no idea what we might find" |

### Dimension 3: Opens New Possibilities (0-10)

**Question**: Does this expand the adjacent possible?

| Score | Description | Indicators |
|-------|-------------|------------|
| 0-2 | Dead end | - Closes off future options<br>- Highly specialized with no broader applications<br>- Doesn't enable new capabilities<br>- "This is a terminal node" |
| 3-4 | Limited expansion | - Opens 1-2 new directions<br>- Narrow applications<br>- Enables minor variations<br>- "A small step forward" |
| 5-6 | Moderate expansion | - Opens 3-5 new directions<br>- Some broader applications<br>- Enables new capabilities in specific areas<br>- "Opens some interesting doors" |
| 7-8 | Significant expansion | - Opens 6+ new directions<br>- Broad applications across domains<br>- Enables new classes of capabilities<br>- "Opens many new possibilities" |
| 9-10 | Paradigm shift | - Opens countless new directions<br>- Transformative applications<br>- Fundamentally new capabilities<br>- "Changes what's possible" |

### Dimension 4: Intrinsic Interest (0-10)

**Question**: Is it interesting for its own sake, regardless of utility?

| Score | Description | Indicators |
|-------|-------------|------------|
| 0-2 | Boring | - Feels like a chore<br>- No curiosity about outcomes<br>- Purely instrumental<br>- "We're only doing this because we have to" |
| 3-4 | Mildly interesting | - Some curiosity<br>- Slightly engaging<br>- Mostly instrumental with minor intrigue<br>- "It's okay, I guess" |
| 5-6 | Moderately interesting | - Genuine curiosity<br>- Engaging to work on<br>- Interesting independent of outcomes<br>- "I'm curious to see what happens" |
| 7-8 | Highly interesting | - Strong curiosity<br>- Exciting to work on<br>- Fascinating independent of utility<br>- "I really want to explore this" |
| 9-10 | Compelling | - Irresistible curiosity<br>- Thrilling to work on<br>- Captivating for its own sake<br>- "I can't stop thinking about this" |

### Calculating Novelty Score

**Formula**: Novelty Score = (Unexplored + Surprise + Opens Doors + Interest) / 4

**Interpretation**:
- **0-3**: Low novelty - routine work
- **4-6**: Moderate novelty - incremental innovation
- **7-8**: High novelty - significant exploration
- **9-10**: Extreme novelty - breakthrough potential

## 2. Stepping Stone Recognition

### Characteristics of Good Stepping Stones

Use this checklist to identify valuable stepping stones:

#### ✅ Positive Indicators

- [ ] **Opens adjacent possible**: Creates new options that weren't available before
- [ ] **Interesting in itself**: Valuable to explore regardless of where it leads
- [ ] **Builds capability**: Develops skills, knowledge, or infrastructure
- [ ] **Reveals information**: Teaches something about the problem space
- [ ] **Enables experimentation**: Makes it easier to try new things
- [ ] **Attracts curiosity**: People want to explore it further
- [ ] **Combines ideas**: Brings together previously separate concepts
- [ ] **Challenges assumptions**: Questions what was taken for granted

#### ❌ Negative Indicators (Not good stepping stones)

- [ ] **Dead end**: Doesn't lead anywhere new
- [ ] **Purely instrumental**: Only valuable if it achieves a specific goal
- [ ] **Closes options**: Locks in decisions that prevent exploration
- [ ] **Boring**: No intrinsic interest or curiosity
- [ ] **Obvious**: Everyone already knows about it
- [ ] **Isolated**: Doesn't connect to other possibilities

### Stepping Stone Quality Matrix

| Quality | Description | Example |
|---------|-------------|---------|
| **Excellent** | Opens many doors, highly interesting, builds significant capability | Implementing a flexible plugin system (enables countless extensions) |
| **Good** | Opens several doors, interesting, builds useful capability | Adding comprehensive logging (enables debugging, analytics, monitoring) |
| **Moderate** | Opens a few doors, somewhat interesting, builds some capability | Refactoring to extract a utility module (enables reuse in a few places) |
| **Weak** | Opens one door, mildly interesting, minimal capability gain | Renaming variables for clarity (helps readability, doesn't enable much) |
| **Poor** | Dead end, boring, no capability gain | Hardcoding a specific value (closes off flexibility) |

## 3. Objective Trap Detection

### Red Flags Checklist

Use this checklist to identify when objectives might be counterproductive:

#### 🚩 Planning Red Flags

- [ ] **Overly specific distant goals**: "In 2 years, we'll have exactly X users and Y revenue"
- [ ] **Assumed linear path**: "We'll do A, then B, then C, and arrive at Z"
- [ ] **No room for discovery**: "We know exactly what we're building"
- [ ] **Dismissing tangents**: "That's interesting but not on the roadmap"
- [ ] **Premature optimization**: "Let's design for 1M users when we have 100"
- [ ] **Rigid milestones**: "We must complete X by date Y, no exceptions"
- [ ] **Goal-distance metrics**: "Success = how close we are to the target"

#### 🚩 Mindset Red Flags

- [ ] **Tunnel vision**: Only seeing paths that point toward the goal
- [ ] **Sunk cost fallacy**: "We've invested too much to pivot"
- [ ] **Fear of exploration**: "We can't afford to experiment"
- [ ] **Devaluing learning**: "That's interesting but doesn't help us ship"
- [ ] **Impatience with process**: "Just tell me the solution"
- [ ] **Binary thinking**: "Either we achieve the goal or we failed"

#### 🚩 Organizational Red Flags

- [ ] **Innovation on schedule**: "We need a breakthrough by Q3"
- [ ] **Punishing 'failure'**: Penalizing experiments that don't achieve goals
- [ ] **Requiring justification**: All work must tie to strategic objectives
- [ ] **No exploration budget**: 100% of resources allocated to planned work
- [ ] **Ignoring serendipity**: "That's not what we're here to do"

### Objective Trap Severity

| Severity | Description | Action |
|----------|-------------|--------|
| **Critical** | 5+ red flags, rigid mindset, no exploration | Major intervention needed - reframe entire approach |
| **High** | 3-4 red flags, mostly goal-driven | Significant rebalancing - add exploration time |
| **Moderate** | 1-2 red flags, some flexibility | Minor adjustment - encourage more openness |
| **Low** | 0 red flags, balanced approach | Maintain current balance |

## 4. Exploration Direction Evaluation

### Criteria for Recommending Directions

When generating exploration directions, prioritize based on:

#### Primary Criteria (Must have at least 2 of 3)

1. **High novelty score** (7+): Significantly unexplored with surprise potential
2. **Opens many doors** (7+): Expands adjacent possible substantially
3. **Strong intrinsic interest** (7+): Compelling to explore for its own sake

#### Secondary Criteria (Nice to have)

4. **Builds transferable capability**: Skills/knowledge useful in multiple contexts
5. **Low cost to explore**: Can take a small step without major commitment
6. **Connects disparate ideas**: Brings together previously separate concepts
7. **Challenges orthodoxy**: Questions established assumptions

#### Anti-Criteria (Avoid if present)

- **Purely goal-directed**: Only valuable if it achieves a specific objective
- **High cost, low learning**: Expensive to explore with little knowledge gain
- **Obvious next step**: Everyone would think of this (not novel)
- **Closes off options**: Makes future pivots difficult

### Direction Recommendation Template

For each exploration direction, provide:

```markdown
#### [Direction Name]

**Novelty Score**: X.X/10
- Unexplored: X/10
- Surprise: X/10  
- Opens Doors: X/10
- Interest: X/10

**Why it's interesting**: [What makes this novel or intriguing - NOT how it helps achieve goals]

**What you might discover**: [Potential learnings, new capabilities, unexpected insights]

**What doors it opens**: [New possibilities that become available]

**Next small step**: [Concrete, low-cost action to begin exploring]

**Cautions**: [Any risks or considerations]
```

## 5. Journey Analysis Patterns

### Patterns to Look For

When analyzing exploration journeys, look for these patterns:

#### Positive Patterns

- **Serendipitous connections**: Discoveries that link previously separate explorations
- **Capability accumulation**: Each stepping stone builds on previous ones
- **Expanding horizons**: Adjacent possible grows over time
- **Productive pivots**: Changes in direction that opened new value
- **Emergent goals**: Objectives that emerged from exploration, not predetermined

#### Warning Patterns

- **Circular exploration**: Revisiting the same areas without progress
- **Scattered exploration**: No connection between stepping stones
- **Diminishing novelty**: Each step becomes more routine
- **Forced connections**: Trying to justify explorations by goal-distance
- **Premature convergence**: Settling on a direction too quickly

### Journey Health Metrics

| Metric | Healthy | Concerning |
|--------|---------|------------|
| **Novelty trend** | Maintaining 6+ average | Declining below 5 |
| **Door opening** | Each stone opens 3+ new directions | Stones open <2 directions |
| **Capability growth** | New skills/knowledge each step | Repetitive work |
| **Surprise rate** | Regular unexpected discoveries | Predictable outcomes |
| **Interest level** | Sustained curiosity | Growing boredom |

## 6. Balancing Exploration and Exploitation

### Portfolio Approach

Recommend resource allocation based on context:

| Context | Exploration | Exploitation | Rationale |
|---------|-------------|--------------|-----------|
| **Early stage / R&D** | 70-80% | 20-30% | Need to discover what's possible |
| **Innovation project** | 50-60% | 40-50% | Balance discovery and delivery |
| **Mature product** | 20-30% | 70-80% | Optimize known solutions, maintain innovation |
| **Maintenance mode** | 10-20% | 80-90% | Focus on efficiency, keep options open |

### Adaptive Signals

Adjust the balance based on these signals:

**Increase exploration when**:
- Hitting diminishing returns on current approach
- Feeling stuck or constrained
- Market/technology landscape is shifting
- Competitors are innovating rapidly
- Team is bored or disengaged

**Increase exploitation when**:
- Clear opportunity with known path
- Time-sensitive window
- Need to build on recent discoveries
- Resources are constrained
- Stakeholders need tangible results

## 7. Communication Guidelines

### Framing Exploration to Stakeholders

When communicating about exploration-driven work:

#### Do:
- Frame as "learning" and "capability building"
- Emphasize what doors are opened, not goal-distance
- Share surprising discoveries and insights
- Explain how exploration reduces risk
- Highlight emergent opportunities

#### Don't:
- Apologize for not achieving predetermined goals
- Justify exploration only by eventual goal achievement
- Promise specific outcomes from exploration
- Treat exploration as "wasted time"
- Force retrospective goal-directed narratives

### Example Framings

**Weak**: "We explored X but it didn't help us achieve goal Y"

**Strong**: "Exploring X revealed that [surprising insight], which opens up possibilities for [new directions]"

---

**Weak**: "This refactoring doesn't add features but we need to do it"

**Strong**: "This refactoring builds capability that enables [new classes of features] and makes future changes easier"

---

**Weak**: "We failed to reach our goal but learned something"

**Strong**: "We discovered [unexpected insight] that suggests a more promising direction toward [emergent opportunity]"
