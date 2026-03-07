import { useState, useEffect, useCallback } from "react";
import { getConfig, getModels, putConfig } from "../api";
import type { UserConfig } from "../types";
import type { ModelInfo } from "../api";

export function useConfig() {
  const [config, setConfig] = useState<UserConfig | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);

  const refresh = useCallback(() => {
    Promise.all([getConfig(), getModels()]).then(([c, m]) => {
      setConfig(c);
      setModels(Array.isArray(m) ? m : []);
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setModelId = useCallback(async (modelId: string) => {
    try {
      const updated = await putConfig({ modelId });
      setConfig(updated);
    } catch {
      // keep local state on error
    }
  }, []);

  return {
    config,
    refresh,
    setModelId,
    models,
    modelId: config?.modelId,
  };
}
