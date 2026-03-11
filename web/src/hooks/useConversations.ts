import { useState, useEffect, useCallback, useRef } from "react";
import { listConversations, getMessages, getConversation } from "../api";
import type { ConversationMeta, StoredMessage } from "../types";

export function useConversations(conversationIdFromUrl: string | undefined) {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [current, setCurrent] = useState<ConversationMeta | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const currentIdRef = useRef<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const { conversations: list } = await listConversations({ limit: 200 });
      setConversations(list);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Sync current conversation from URL
  useEffect(() => {
    if (!conversationIdFromUrl) {
      currentIdRef.current = null;
      setCurrent(null);
      setMessages([]);
      setLoadError(null);
      return;
    }
    const id = conversationIdFromUrl;
    getConversation(id)
      .then((meta) => {
        if (!meta) {
          currentIdRef.current = null;
          setCurrent(null);
          setMessages([]);
          return;
        }
        currentIdRef.current = id;
        setCurrent(meta);
        setLoadError(null);
      })
      .catch(() => {
        currentIdRef.current = null;
        setCurrent(null);
        setMessages([]);
        setLoadError("会话不存在或已删除");
      });
  }, [conversationIdFromUrl]);

  useEffect(() => {
    if (!current) {
      setMessages([]);
      return;
    }
    const id = current.id;
    currentIdRef.current = id;
    getMessages(id)
      .then((list) => {
        if (currentIdRef.current !== id) return;
        setMessages(Array.isArray(list) ? list : []);
      })
      .catch((e) => {
        if (currentIdRef.current === id) {
          setMessages([]);
          setLoadError(String(e));
        }
      });
  }, [current?.id]);

  return {
    conversations,
    current,
    setCurrent,
    messages,
    setMessages,
    loadList,
    loadError,
  };
}
