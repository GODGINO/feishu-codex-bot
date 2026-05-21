const BASE = '/api';

export async function fetchApi<T = any>(url: string): Promise<T> {
  return fetchJson(url);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${BASE}${url}`);
  if (res.status === 401) {
    window.location.reload();
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function mutate<T = { ok: boolean }>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { window.location.reload(); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `API error: ${res.status}`);
  }
  return res.json();
}

export interface SessionSummary {
  key: string;
  name: string;
  type: 'group' | 'dm' | 'other';
  chatId: string | null;
  autoReply: string | null;
  memberCount: number;
  cronJobCount: number;
  alertCount: number;
  messageCount: number;
  hasEmail: boolean;
  hasKnowledge: boolean;
  skillCount: number;
  skillNames: string[];
  lastActiveAt: number | null;
}

export interface WechatBinding {
  wechatUserId: string;
  botToken: string;
  ilinkBotId: string;
  baseUrl: string;
  boundAt: number;
  status: 'active' | 'inactive';
}

export interface SessionDetail extends SessionSummary {
  authors: Record<string, { name: string; feishuMcpUrl?: string }>;
  sshPublicKey: string | null;
  model: string | null;
  wechatBinding: WechatBinding | null;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
}

export interface AlertWatermark {
  last_pubdate: number;
  processed_ids: string[];
  max_processed_size?: number;
}

export interface AlertStats {
  polls: number;
  triggers: number;
  failures: number;
  last_poll?: string;
  last_trigger?: string;
}

export interface Alert {
  id: string;
  name: string;
  type: 'one_shot' | 'watcher';
  enabled: boolean;
  interval_seconds: number;
  check_command: string;
  prompt: string;
  execution_mode: 'claude' | 'shell' | 'message_only';
  trigger_command?: string;
  state: { watermark: AlertWatermark; stats: AlertStats };
  max_runtime_days?: number;
  createdAt: string;
}

export interface ChatMessage {
  timestamp: number;
  senderName: string;
  text: string;
  botReply?: string;
  senderOpenId?: string;
}

export interface ChatResponse {
  messages: ChatMessage[];
  total: number;
  page: number;
  limit: number;
}

export interface Stats {
  totalSessions: number;
  groupSessions: number;
  dmSessions: number;
  totalMessages: number;
  todayMessages: number;
  totalCronJobs: number;
  totalAlerts: number;
  totalEmailAccounts: number;
  totalSkills: number;
  totalObservations: number;
}

export interface EmailInfo {
  configured: boolean;
  pushTarget: any;
  rules: string | null;
}

export interface Skill {
  folder: string;
  name: string;
  description: string;
  content: string;
  disabled: boolean;
  builtin: boolean;
  envVars: string[];
}

export interface Observation {
  id: number
  type: string
  title: string
  narrative: string
  facts: string
  concepts: string
  files_read: string
  files_modified: string
  created_at_epoch: number
  project: string
}

export interface SessionSummaryMem {
  id: number
  request: string
  investigated: string
  learned: string
  completed: string
  next_steps: string
  created_at_epoch: number
}

export interface MemoryResponse {
  observations: Observation[]
  total: number
  page: number
  limit: number
}

export interface SummariesResponse {
  summaries: SessionSummaryMem[]
  total: number
}

export interface EnvVariable {
  key: string
  value: string
}

export interface EnvResponse {
  variables: EnvVariable[]
  skillEnvMap: Record<string, string[]>
}

export interface Member {
  openId: string
  name: string
  feishuMcpUrl?: string
  sessions: string[]
  muted: boolean
  createdAt: number
  updatedAt: number
  memberMd?: string
}

export interface SwitcherStatus {
  current: string | null
  switchCount: number
  lastSwitchTs: number | null
  cooldowns: Record<string, number>
  paused: boolean
  usage: number | null
  breakdown: Record<string, number>
  accounts: Array<{ email: string; label: string }>
}

export const api = {
  sessions: () => fetchJson<SessionSummary[]>('/sessions'),
  session: (key: string) => fetchJson<SessionDetail>(`/sessions/${key}`),
  knowledge: (key: string) => fetchJson<{ content: string }>(`/sessions/${key}/knowledge`),
  updateKnowledge: (key: string, content: string) =>
    mutate('PUT', `/sessions/${key}/knowledge`, { content }),
  cron: (key: string) => fetchJson<CronJob[]>(`/sessions/${key}/cron`),
  chat: (key: string, page = 1, limit = 50) =>
    fetchJson<ChatResponse>(`/sessions/${key}/chat?page=${page}&limit=${limit}`),
  email: (key: string) => fetchJson<EmailInfo>(`/sessions/${key}/email`),
  sessionEnv: (key: string) => fetchJson<EnvResponse>(`/sessions/${key}/env`),
  updateSessionEnv: (key: string, variables: EnvVariable[]) =>
    mutate('PUT', `/sessions/${key}/env`, { variables }),
  skills: (key: string) => fetchJson<Skill[]>(`/sessions/${key}/skills`),
  memory: (key: string, page = 1, limit = 20, search?: string, type?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) })
    if (search) params.set('search', search)
    if (type) params.set('type', type)
    return fetchJson<MemoryResponse>(`/sessions/${key}/memory?${params}`)
  },
  memorySummaries: (key: string, page = 1, limit = 10) =>
    fetchJson<SummariesResponse>(`/sessions/${key}/memory/summaries?page=${page}&limit=${limit}`),
  stats: () => fetchJson<Stats>('/stats'),
  authCheck: async () => {
    const res = await fetch(`${BASE}/auth/check`);
    return res.ok;
  },
  login: async (password: string, password2: string) => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, password2 }),
    });
    return res.ok;
  },
  logout: async () => {
    await fetch(`${BASE}/auth/logout`, { method: 'POST' });
  },

  // Skill management
  deleteSkill: (sessionKey: string, folder: string) =>
    mutate('DELETE', `/sessions/${sessionKey}/skills/${folder}`),
  toggleSkill: (sessionKey: string, folder: string, disabled: boolean) =>
    mutate('PUT', `/sessions/${sessionKey}/skills/${folder}/toggle`, { disabled }),
  transferSkill: (sessionKey: string, folder: string, targetSession: string, transferEnvVars = false) =>
    mutate('POST', `/sessions/${sessionKey}/skills/${folder}/transfer`, { targetSession, transferEnvVars }),

  // Cron management
  deleteCronJob: (sessionKey: string, jobId: string) =>
    mutate('DELETE', `/sessions/${sessionKey}/cron/${jobId}`),
  toggleCronJob: (sessionKey: string, jobId: string, enabled: boolean) =>
    mutate('PUT', `/sessions/${sessionKey}/cron/${jobId}/toggle`, { enabled }),

  // Alert management
  alerts: (key: string) => fetchJson<Alert[]>(`/sessions/${key}/alerts`),
  deleteAlert: (sessionKey: string, alertId: string) =>
    mutate('DELETE', `/sessions/${sessionKey}/alerts/${alertId}`),
  toggleAlert: (sessionKey: string, alertId: string, enabled: boolean) =>
    mutate('PUT', `/sessions/${sessionKey}/alerts/${alertId}/toggle`, { enabled }),
  resetAlert: (sessionKey: string, alertId: string) =>
    mutate('PUT', `/sessions/${sessionKey}/alerts/${alertId}/reset`, {}),

  // Author management
  deleteAuthor: (sessionKey: string, openId: string) =>
    mutate('DELETE', `/sessions/${sessionKey}/authors/${openId}`),
  unbindWechat: (sessionKey: string) =>
    mutate('DELETE', `/sessions/${sessionKey}/wechat`),
  updateAuthor: (sessionKey: string, openId: string, data: { name?: string; feishuMcpUrl?: string }) =>
    mutate('PUT', `/sessions/${sessionKey}/authors/${openId}`, data),

  // Refresh name caches (force re-fetch from Feishu API)
  refreshNames: () => mutate('POST', '/refresh-names'),

  // Sigma-switcher (account rotation daemon)
  switcherStatus: () => fetchJson<SwitcherStatus>('/switcher/status'),
  switcherPause: () => mutate('POST', '/switcher/pause'),
  switcherResume: () => mutate('POST', '/switcher/resume'),
  switcherTrigger: (email: string) => mutate('POST', '/switcher/trigger', { email }),

  // Session config (simple key-value files like streaming-reply, auto-reply)
  getSessionConfig: async (sessionKey: string, configName: string): Promise<string> => {
    const r = await fetchJson<{ value: string }>(`/sessions/${sessionKey}/config/${configName}`);
    return r.value;
  },
  setSessionConfig: (sessionKey: string, configName: string, value: string) =>
    mutate('PUT', `/sessions/${sessionKey}/config/${configName}`, { value }),

  // Members
  members: () => fetchJson<Member[]>('/members'),
  member: (openId: string) => fetchJson<Member>(`/members/${openId}`),
  updateMember: (openId: string, data: Record<string, unknown>) =>
    mutate('PUT', `/members/${openId}`, data),
  toggleMemberMute: (openId: string, muted: boolean) =>
    mutate('PUT', `/members/${openId}/mute`, { muted }),
  getMemberMd: (openId: string) =>
    fetchJson<{ content: string }>(`/members/${openId}/member-md`),
  updateMemberMd: (openId: string, content: string) =>
    mutate('PUT', `/members/${openId}/member-md`, { content }),
  deleteMember: (openId: string) =>
    mutate('DELETE', `/members/${openId}`),

  // Admin chat — send message via REST
  sendAdminChat: (sessionKey: string, text: string, echo: boolean, showSource = true, sendAsSigma = false, addToContext = true) =>
    mutate('POST', `/sessions/${sessionKey}/chat/send`, { text, echo, showSource, sendAsSigma, addToContext }),
};
