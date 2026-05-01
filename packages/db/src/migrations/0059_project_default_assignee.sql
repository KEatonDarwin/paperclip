ALTER TABLE "projects" ADD COLUMN "default_assignee_agent_id" uuid REFERENCES "agents"("id");
