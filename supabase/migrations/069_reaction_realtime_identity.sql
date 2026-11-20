-- Conversation-filtered DELETE delivery needs the old conversation_id in WAL.
-- Realtime still restricts deleted-row payloads to the primary key when RLS is enabled.
ALTER TABLE public.message_reactions REPLICA IDENTITY FULL;
