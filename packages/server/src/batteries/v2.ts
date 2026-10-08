/**
 * Battery v2: the same judgments as v1, asked as Choice questions only, plus spam and a
 * finer target. Choice is the question type Laya handles best, so answers collected
 * with this battery double as Laya training targets. Every question stands on its
 * own: the model never sees the ids, and questions cannot see each other's answers.
 */

import type { Battery } from '@kommentarwache/contract';

export const SEVERITY_LEVELS = ['benign', 'rude', 'harassment', 'threat'] as const;

export const BATTERY_V2: Battery = {
  name: 'v2-choice',
  // 2: severity's benign level says that quoting or reporting abuse is not abuse, as the
  //    attack question already did; version 1 scored a quoted slur as rude.
  version: 2,
  questions: {
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
    attack: {
      type: 'choice',
      instructions:
        'Does the author of `comment` attack, insult, demean, threaten, or wish harm ' +
        'on a person or a group of people?',
      criteria: {
        no_attack:
          'The author does not attack people. Criticizing a product, idea, decision, policy, ' +
          'or piece of content is not an attack on a person. Insulting only oneself does not ' +
          "count. Quoting or reporting someone else's abuse is not the author attacking anyone.",
        attacks_person_or_group:
          'The author insults, belittles, mocks, threatens, or dehumanizes a person or group, ' +
          "including the post's author, another commenter, a public figure, or a group of people.",
      },
    },
    target: {
      type: 'choice',
      instructions:
        'Who or what is any negativity or criticism in `comment` directed at? ' +
        'If the comment contains no negativity or criticism, choose nobody.',
      criteria: {
        nobody: 'There is no negativity or criticism in the comment.',
        content_or_product:
          'A product, service, company, idea, decision, policy, article, video, or other ' +
          'piece of content, not a person.',
        other_commenter:
          "A participant in this conversation: the post's author, the page or channel " +
          'owner, or a fellow commenter.',
        public_figure:
          'A politician, celebrity, executive, or other public figure who is the subject ' +
          'of the post or the discussion rather than a participant in it.',
        group:
          'A group of people defined by nationality, ethnicity, religion, gender, ' +
          'sexuality, disability, age, or a similar characteristic.',
        self: 'The author of the comment is only criticizing or insulting themselves.',
      },
    },
    severity: {
      type: 'choice',
      instructions:
        'How severe would `comment` be under a typical community content policy? ' +
        'Pick the most serious level that applies.',
      criteria: {
        benign:
          'No policy concern at all, including blunt or negative opinions about products, ' +
          "ideas, decisions, or content, and quoting or reporting someone else's abuse " +
          'in order to object to it.',
        rude:
          'Dismissive, mocking, sarcastic, or mildly insulting toward a person, but no slur, ' +
          'no threat, and no dehumanizing language.',
        harassment:
          'Vicious personal abuse, a slur, sexual harassment, or dehumanizing language ' +
          'about a person or group.',
        threat:
          'A threat of violence, a wish for someone to be harmed or killed, incitement, ' +
          "or publishing someone's private information.",
      },
    },
    spam: {
      type: 'choice',
      instructions: 'Is `comment` spam or a scam rather than a contribution to the conversation?',
      criteria: {
        not_spam:
          'A normal contribution to the conversation, even if it includes a link that ' +
          'supports its point or mentions a product in passing.',
        spam_or_scam:
          'Promotional or repetitive solicitation, a bare link with no substance, ' +
          '"check out my channel", crypto or get-rich schemes, phishing, impersonation, ' +
          'or a deceptive offer.',
      },
    },
  },
};
