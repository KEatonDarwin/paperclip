import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createProviderModelSchema, updateProviderModelSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, modelCatalogService } from "../services/index.js";

export function modelCatalogRoutes(db: Db) {
  const router = Router();
  const svc = modelCatalogService(db);

  router.get("/companies/:companyId/model-catalog", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const models = await svc.listCatalog(companyId);
    res.json(models);
  });

  router.get("/companies/:companyId/model-catalog/providers", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const statuses = await svc.providerStatuses(companyId);
    res.json(statuses);
  });

  router.post("/companies/:companyId/model-catalog/refresh", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const provider = typeof req.body?.provider === "string" ? req.body.provider : "anthropic";
    const result = await svc.refreshProvider(companyId, provider);
    res.json(result);
  });

  router.post(
    "/companies/:companyId/model-catalog/models",
    validate(createProviderModelSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const created = await svc.createManual(companyId, req.actor.userId ?? null, {
        provider: req.body.provider,
        modelKey: req.body.modelKey,
        displayName: req.body.displayName,
        contextWindow: req.body.contextWindow,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "model_catalog.model_added",
        entityType: "provider_model",
        entityId: created.id,
        details: { provider: created.provider, modelKey: created.modelKey },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/model-catalog/models/:id",
    validate(updateProviderModelSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertCompanyAccess(req, companyId);

      const updated = await svc.update(companyId, id, req.body);
      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/model-catalog/models/:id", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);

    await svc.remove(companyId, id);
    res.status(204).send();
  });

  return router;
}
