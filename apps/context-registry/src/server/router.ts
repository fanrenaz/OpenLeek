import { contextInstallationCreateSchema, contextInstallationStateSchema } from "@openleek/contracts/context";
import { identifierSchema } from "@openleek/contracts/core";
import { domainProcedure, t } from "@openleek/trpc";
import { z } from "zod";
import { contextRegistry } from "./runtime";
const service = () => contextRegistry();
export const contextRegistryRouter = t.router({ contextRegistry: t.router({
  list: domainProcedure.input(z.object({}).strict()).query(async () => ({ installations: await (await service()).list() })),
  get: domainProcedure.input(z.object({ installationRef: identifierSchema }).strict()).query(async ({ input }) => (await service()).get(input.installationRef)),
  create: domainProcedure.input(contextInstallationCreateSchema).mutation(async ({ input }) => (await service()).create(input)),
  transition: domainProcedure.input(z.object({ installationRef: identifierSchema, state: contextInstallationStateSchema, failure: z.string().min(1).max(10_000).optional() }).strict()).mutation(async ({ input }) => (await service()).transition(input.installationRef, input.state, input.failure)),
  activate: domainProcedure.input(z.object({ installationRef: identifierSchema }).strict()).mutation(async ({ input }) => (await service()).verifyAndActivate(input.installationRef)),
  resolve: domainProcedure.input(z.object({ installationRef: identifierSchema }).strict()).query(async ({ input }) => (await service()).resolve(input.installationRef)),
}) });
export type ContextRegistryRouter = typeof contextRegistryRouter;
