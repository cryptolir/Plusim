-- CreateTable
CREATE TABLE "ConversationView" (
    "conversationId" TEXT NOT NULL,
    "lastViewedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationView_pkey" PRIMARY KEY ("conversationId")
);

-- AddForeignKey
ALTER TABLE "ConversationView" ADD CONSTRAINT "ConversationView_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: seed every existing conversation as "viewed" at its last activity so
-- pre-existing chats don't all show as unread on first load after this migration.
INSERT INTO "ConversationView" ("conversationId", "lastViewedAt")
SELECT "id", "updatedAt" FROM "Conversation";
