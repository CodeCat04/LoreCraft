/** The wizard's progress, saved in the project so it can be left and picked up again. */

import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

import * as api from '../lib/api';
import { emptyPlan, parseStored, type PlanState } from './plan';

export const PLAN_META_KEY = 'planWizard';

interface PlanStore {
  plan: PlanState;
  loaded: boolean;
}

export const usePlan = create<PlanStore>(() => ({ plan: emptyPlan(), loaded: false }));

let saveTimer: number | undefined;
let loading: Promise<void> | null = null;

/** Reads the saved progress, once per project. */
export function loadPlan(): Promise<void> {
  if (usePlan.getState().loaded) return Promise.resolve();
  loading ??= api.project
    .getMeta(PLAN_META_KEY)
    .then((text) => usePlan.setState({ plan: parseStored(text) ?? emptyPlan(), loaded: true }))
    .catch(() => usePlan.setState({ plan: emptyPlan(), loaded: true }))
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** Changes the plan and saves it soon after. */
export function updatePlan(change: Partial<PlanState> | ((plan: PlanState) => Partial<PlanState>)) {
  usePlan.setState((s) => ({ plan: { ...s.plan, ...(typeof change === 'function' ? change(s.plan) : change) } }));
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void savePlanNow(), 500);
}

export async function savePlanNow(): Promise<void> {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!usePlan.getState().loaded) return;
  await api.project.setMeta(PLAN_META_KEY, JSON.stringify(usePlan.getState().plan)).catch(() => {});
}

/** True while a change is waiting to be saved. */
export const planSavePending = () => saveTimer !== undefined;

export async function startOver(): Promise<void> {
  usePlan.setState({ plan: emptyPlan(), loaded: true });
  await savePlanNow();
}

export function registerPlanStore() {
  void listen<{ entity: string }>('data://changed', (event) => {
    if (event.payload.entity !== 'all') return;
    // Another project: what was on screen belongs to the old one.
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    usePlan.setState({ plan: emptyPlan(), loaded: false });
  });
}
