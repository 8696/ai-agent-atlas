import axios from 'axios';

/**
 * REST 客户端 —— **一个 axios 实例**，baseURL `/api/v1`。
 *
 * ⚠️ **没有鉴权头、没有 401 拦截** —— 服务端完全免鉴权（见 [12-a A1](../docs/12-a-需求-应用外壳与上下文.md)）。
 * ⚠️ **SSE 不用它** —— SSE 走 `useChat` 的 transport（fetch + ReadableStream）。
 */

export const api = axios.create({
  baseURL: '/api/v1',
  timeout: 10_000,
});

/** 可用模型 */
export interface ModelInfo {
  name: string;
  role: 'primary' | 'fallback';
}

export interface ModelsResponse {
  /** 配没配模型 */
  configured: boolean;
  models: ModelInfo[];
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
}

/** 当前可用模型（**不回显 API Key**） */
export async function fetchModels(): Promise<ModelsResponse> {
  const { data } = await api.get<ModelsResponse>('/models');
  return data;
}

/** 后端健康检查 */
export async function fetchHealth(): Promise<HealthResponse> {
  const { data } = await api.get<HealthResponse>('/health');
  return data;
}
