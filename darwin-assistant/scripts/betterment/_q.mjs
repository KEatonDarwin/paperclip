import Database from 'better-sqlite3';
const db = new Database('/tmp/bl-live/jarvis.db', {readonly:true});
const q = s => console.log(s.slice(0,90), '\n ', JSON.stringify(db.prepare(s).all()));
q("select max(created_at), min(created_at), count(*) from turns where role='tool_call' and input_tokens is not null");
q("select t.conversation_id, t.turn_index, t.role, t.input_tokens, t.cache_read_tokens, t.output_tokens, t.created_at from turns t where t.conversation_id = (select conversation_id from turns where role='tool_call' and input_tokens is not null order by id desc limit 1) order by turn_index desc limit 8");
q("select substr(created_at,1,10) d, count(*) n, sum(role='assistant') a from turns where created_at >= '2026-10-08' group by d");
q("select count(*) , sum(integrates_node_id is not null), sum(title like 'integrate n%') from hopper_nodes");
