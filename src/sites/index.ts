import { chatgptSite } from './chatgpt';
import { claudeSite } from './claude';
import type { Site } from './types';

export const SITES: Site[] = [claudeSite, chatgptSite];

/** 開いているページのホスト名から、どのサイトかを決める。対象外なら null */
export function detectSite(hostname: string): Site | null {
  if (hostname === 'claude.ai') return claudeSite;
  if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') return chatgptSite;
  return null;
}
