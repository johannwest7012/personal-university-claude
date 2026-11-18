# Writing questions for Personal University

These rules come from the first live quiz session on Space to Grow, chapter 1. They are the brief for anyone, human or model, writing questions for the bank.

## The core rule: distractors must come from the material

A wrong option must be one of these:

1. **True of something else in the source.** The Falcon 9's $2,800 per kilogram as a wrong answer for the shuttle's cost. Fixed-price as a wrong answer for cost-plus. A real COTS feature as a wrong answer for a question about a different COTS feature.
2. **A plausible misreading.** Reversed cause and effect ("private rockets were retired, so the shuttle got the payloads"), the right fact attached to the wrong period, a partial answer.

Never invent a reason. A learner who understood the chapter rejects invented reasons on sight, without retrieving anything, and the question teaches nothing. In the first session, questions with invented distractors were answered by general reasoning alone.

## Every distractor carries a "why"

Each wrong option has a one- or two-sentence explanation of why it is wrong, and where possible what it is actually true of. This:

- forces the writer to check that every distractor is unambiguously wrong;
- gives instant feedback when the learner taps without explaining;
- grounds the AI's response when the learner does explain.

If you can't write a crisp "why", the distractor is either invented or arguably correct. Replace it.

## No defensible alternatives

If a distractor could be argued as correct from the text, it's a bad question, not a hard one. Two true statements where the question asks which one "the authors emphasize" is a trap to avoid unless the distinction is the point being taught.

## What's worth asking

- **Near-neighbor discrimination is the strongest format.** Programs with similar names (COTS, CRS, Commercial Crew, Constellation), two halves of one story (development cost vs operating cost), a cause vs the means used to achieve it.
- **Mechanisms and arguments over trivia.** Ask why the shuttle needed defense payloads, not what year the first shuttle flew. Numbers are worth asking when they carry the argument (sixty flights projected, fewer than five flown), and then ask about magnitude, not decimals.
- **Don't quiz quote attribution** unless the quote is the concept.
- **Application questions** put the concept in a new situation. Their distractors should be the chapter's other patterns (the shuttle's monopoly, its cost overrun, the jobs program), so the learner must tell the patterns apart.

## Form

- Four options: one answer, three distractors.
- The correct answer's length position (shortest to longest) should be roughly even across the bank. Writers tend to make the answer the longest, most qualified option; overcorrecting makes it never the longest. Either is guessable. `scripts/validate-bank.mjs` reports it.
- Keep options parallel in grammar and length. Phone-screen short.
- "NOT" questions are fine when the three true options are each worth knowing.
- Mark questions whose answer is reasoning beyond the text with `"reasoning": true`.
