/**
 * Battery v1: the prototype's four questions, verbatim. One request answers all of them
 * in parallel against the same state. Question ids are for code only; the model never
 * sees them, so each question carries its full meaning in instructions and criteria.
 */

import type { Battery } from '@kommentarwache/contract';

export const BATTERY_V1: Battery = {
  name: 'v1-prototype',
  version: 1,
  questions: {
    // The label the product asked for. Reported as-is; it does not drive the verdict alone.
    sentiment: {
      type: 'choice',
      instructions: 'What overall sentiment does the author of `comment` express?',
      criteria: {
        positive: 'Approval, praise, gratitude, enthusiasm, or support.',
        neutral: 'Informational, a question, or mixed with no clear lean either way.',
        negative:
          'Disapproval, complaint, criticism, anger, sadness, or disappointment, ' +
          'whether aimed at a person, a product, an idea, or a piece of content.',
      },
    },
    // The signal that matters for moderation: is a person being attacked?
    hostile: {
      type: 'noul',
      instructions:
        'Does the author of `comment` attack, insult, demean, threaten, or wish harm ' +
        'on a person or a group of people?',
      criteria: {
        true:
          'The author insults, belittles, mocks, threatens, or dehumanizes a person ' +
          "or group, including the post's author, another commenter, or a named individual.",
        false:
          'The author does not attack people. Criticizing a product, idea, decision, or ' +
          'piece of content is not an attack on a person, and the author insulting only ' +
          'themselves does not count.',
      },
    },
    // Who the negativity lands on, so product criticism and personal attacks can differ.
    target: {
      type: 'choice',
      instructions:
        'Who or what is any negativity or criticism in `comment` directed at? ' +
        'If the comment contains no negativity or criticism, choose nobody.',
      criteria: {
        nobody: 'There is no negativity or criticism in the comment.',
        content_or_product:
          'A product, service, company, idea, decision, article, video, or other ' +
          'piece of content, not a person.',
        individual:
          "A specific person, such as the post's author, another commenter, or a named individual.",
        group:
          'A group of people defined by nationality, ethnicity, religion, gender, ' +
          'sexuality, disability, age, or a similar characteristic.',
        self: 'The author of the comment is only criticizing or insulting themselves.',
      },
    },
    // Graded severity on a written scale, so thresholds live in code.
    severity: {
      type: 'score',
      instructions: 'How severe would `comment` be under a typical community content policy?',
      criteria: [
        'Benign: no policy concern at all, including blunt or negative opinions about products, ideas, or content.',
        'Rude: dismissive, mocking, or mildly insulting toward a person, but no slur, no threat, and no dehumanizing language.',
        'Harassment: vicious personal abuse, a slur, or dehumanizing language about a person or group.',
        'Threat: a threat of violence, a wish for someone to be harmed or killed, incitement, or doxxing.',
      ],
    },
  },
};
