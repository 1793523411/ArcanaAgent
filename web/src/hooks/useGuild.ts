import { useState, useEffect, useCallback } from "react";
import type { Guild, Group, GuildAgent, GuildTask } from "../types/guild";
import {
  getGuild,
  listGroups,
  listGuildAgents,
  getGroupTasks,
  createGroup,
  deleteGroup,
  createGuildAgent,
  updateGuildAgent,
  deleteGuildAgent,
  releaseGuildAgent,
  createGroupTask,
  deleteGuildTask,
  assignGroupTask,
  addAgentToGroup,
  removeAgentFromGroup,
  autoBidTask,
} from "../api/guild";

export function useGuild() {
  const [guild, setGuild] = useState<Guild | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [agents, setAgents] = useState<GuildAgent[]>([]);
  const [tasks, setTasks] = useState<GuildTask[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedGroup = groups.find((g) => g.id === selectedGroupId) ?? null;

  const loadAll = useCallback(async () => {
    try {
      const [guildData, groupsData, agentsData] = await Promise.all([
        getGuild(),
        listGroups(),
        listGuildAgents(),
      ]);
      setGuild(guildData);
      setGroups(groupsData);
      setAgents(agentsData);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTasks = useCallback(async (groupId: string) => {
    try {
      const data = await getGroupTasks(groupId);
      setTasks(data);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (selectedGroupId) {
      loadTasks(selectedGroupId);
    } else {
      setTasks([]);
    }
  }, [selectedGroupId, loadTasks]);

  const handleCreateGroup = useCallback(
    async (payload: { name: string; description: string; sharedContext?: string }) => {
      await createGroup(payload);
      await loadAll();
    },
    [loadAll]
  );

  const handleDeleteGroup = useCallback(
    async (groupId: string) => {
      await deleteGroup(groupId);
      if (selectedGroupId === groupId) setSelectedGroupId(null);
      await loadAll();
    },
    [loadAll, selectedGroupId]
  );

  const handleCreateAgent = useCallback(
    async (payload: Parameters<typeof createGuildAgent>[0]) => {
      await createGuildAgent(payload);
      await loadAll();
    },
    [loadAll]
  );

  const handleUpdateAgent = useCallback(
    async (agentId: string, payload: Parameters<typeof updateGuildAgent>[1]) => {
      await updateGuildAgent(agentId, payload);
      await loadAll();
    },
    [loadAll]
  );

  const handleDeleteAgent = useCallback(
    async (agentId: string) => {
      await deleteGuildAgent(agentId);
      await loadAll();
    },
    [loadAll]
  );

  const handleReleaseAgent = useCallback(
    async (agentId: string) => {
      await releaseGuildAgent(agentId);
      // SSE will broadcast agent_status_changed + task_updated; refresh agent
      // list so the detail panel reflects the new state immediately.
      await loadAll();
      if (selectedGroupId) await loadTasks(selectedGroupId);
    },
    [loadAll, loadTasks, selectedGroupId]
  );

  const handleAddAgentToGroup = useCallback(
    async (groupId: string, agentId: string) => {
      await addAgentToGroup(groupId, agentId);
      await loadAll();
    },
    [loadAll]
  );

  const handleRemoveAgentFromGroup = useCallback(
    async (groupId: string, agentId: string) => {
      await removeAgentFromGroup(groupId, agentId);
      await loadAll();
    },
    [loadAll]
  );

  const handleCreateTask = useCallback(
    async (groupId: string, payload: { title: string; description: string; priority?: GuildTask["priority"] }) => {
      await createGroupTask(groupId, payload);
      await loadTasks(groupId);
    },
    [loadTasks]
  );

  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      await deleteGuildTask(taskId, selectedGroupId ?? undefined);
      if (selectedGroupId) await loadTasks(selectedGroupId);
    },
    [selectedGroupId, loadTasks]
  );

  const handleAssignTask = useCallback(
    async (groupId: string, taskId: string, agentId: string) => {
      await assignGroupTask(groupId, taskId, agentId);
      await loadTasks(groupId);
    },
    [loadTasks]
  );

  const handleAutoBid = useCallback(
    async (groupId: string, taskId: string) => {
      const result = await autoBidTask(groupId, taskId);
      await loadTasks(groupId);
      await loadAll();
      return result;
    },
    [loadTasks, loadAll]
  );

  return {
    guild,
    groups,
    agents,
    tasks,
    selectedGroupId,
    setSelectedGroupId,
    selectedGroup,
    loading,
    error,
    loadAll,
    loadTasks,
    createGroup: handleCreateGroup,
    deleteGroup: handleDeleteGroup,
    createAgent: handleCreateAgent,
    updateAgent: handleUpdateAgent,
    deleteAgent: handleDeleteAgent,
    releaseAgent: handleReleaseAgent,
    addAgentToGroup: handleAddAgentToGroup,
    removeAgentFromGroup: handleRemoveAgentFromGroup,
    createTask: handleCreateTask,
    deleteTask: handleDeleteTask,
    assignTask: handleAssignTask,
    autoBid: handleAutoBid,
  };
}
