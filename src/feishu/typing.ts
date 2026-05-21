import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';

/**
 * Typing indicator using Feishu message reactions.
 * Adds a "TYPING" emoji reaction when processing starts,
 * removes it when done. Only 2 API calls total.
 */
export class TypingIndicator {
  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  /**
   * Add a typing indicator (emoji reaction) to a message.
   * Returns the reaction ID for later removal, or null on failure.
   * @param emoji - 'MeMeMe' (举手, for @mentions) or 'THINKING' (思考, for triage)
   */
  async start(messageId: string, emoji: string = 'MeMeMe'): Promise<string | null> {
    try {
      const resp = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emoji },
        },
      });
      const reactionId = (resp as any).data?.reaction_id;
      return reactionId || null;
    } catch (err) {
      // Non-critical — silently fail
      this.logger.debug({ err, messageId }, 'Failed to add typing indicator');
      return null;
    }
  }

  /**
   * Swap an existing reaction for a new emoji on the same message.
   * Returns the NEW reaction id; pass it back to stop() in the finally
   * block. Order is start-then-stop so the user sees no empty gap
   * (better than emoji flicker if start were to fail).
   */
  async swap(messageId: string, oldReactionId: string | null, newEmoji: string): Promise<string | null> {
    const newId = await this.start(messageId, newEmoji);
    if (oldReactionId) {
      this.stop(messageId, oldReactionId).catch(() => {});
    }
    return newId;
  }

  /**
   * Remove the typing indicator.
   */
  async stop(messageId: string, reactionId: string | null): Promise<void> {
    if (!reactionId) return;

    try {
      await this.client.im.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
    } catch (err) {
      // Non-critical — silently fail
      this.logger.debug({ err, messageId }, 'Failed to remove typing indicator');
    }
  }
}
