-- Preserve knowledge indexed before the document library existed. The old index
-- has no source ID: one imported document represents one (tenant, title) group.
INSERT INTO "Tenant" (id,name,slug)
SELECT DISTINCT tenant_id, 'Entreprise ' || tenant_id, tenant_id FROM knowledge_chunk
WHERE document_id IS NULL ON CONFLICT (id) DO NOTHING;
INSERT INTO "TenantSettings" ("tenantId","updatedBy")
SELECT DISTINCT tenant_id,'usr_MIGRATION' FROM knowledge_chunk WHERE document_id IS NULL
ON CONFLICT ("tenantId") DO NOTHING;
INSERT INTO "SettingsRevision" ("tenantId",version,name,locale,"responseTone","refundApprovalThresholdCents","actorId")
SELECT s."tenantId",s.version,t.name,s.locale,s."responseTone",s."refundApprovalThresholdCents",s."updatedBy"
FROM "TenantSettings" s JOIN "Tenant" t ON t.id=s."tenantId"
ON CONFLICT ("tenantId",version) DO NOTHING;
INSERT INTO "KnowledgeDocument" ("tenantId",id,title,status,"sourceKey","createdBy","publishedVersion")
SELECT tenant_id,'legacy_' || md5(tenant_id || ':' || document_title),left(document_title,300),
 'published','legacy-index','usr_MIGRATION',1
FROM knowledge_chunk WHERE document_id IS NULL GROUP BY tenant_id,document_title;
INSERT INTO "KnowledgeDocumentVersion" ("tenantId","documentId",version,title,content,"createdBy")
SELECT tenant_id,'legacy_' || md5(tenant_id || ':' || document_title),1,left(document_title,300),
 string_agg(content,E'\n\n--- Fragment importé ---\n\n' ORDER BY id),'usr_MIGRATION'
FROM knowledge_chunk WHERE document_id IS NULL GROUP BY tenant_id,document_title;
UPDATE knowledge_chunk SET document_id='legacy_' || md5(tenant_id || ':' || document_title),document_version=1
WHERE document_id IS NULL;
