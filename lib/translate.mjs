// @ts-check
// Compatibility export for existing callers; implementation lives with Chat.
import { chatCompletions } from './protocols/chat-completions.ts';
export const translateRequest = chatCompletions.prepareRequest;
