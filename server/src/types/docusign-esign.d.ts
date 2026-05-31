/**
 * Minimal ambient declaration for `docusign-esign` (no official @types).
 * Covers only the surface used in src/integrations/docusign.ts.
 */
declare module 'docusign-esign' {
  export class ApiClient {
    setBasePath(path: string): void
    setOAuthBasePath(host: string): void
    addDefaultHeader(name: string, value: string): void
    requestJWTUserToken(
      clientId: string,
      userId: string,
      scopes: string[],
      privateKey: Buffer | string,
      expiresIn: number,
    ): Promise<{ body: { access_token: string; expires_in: number } }>
  }

  interface Constructable<T> {
    constructFromObject(obj: Record<string, unknown>): T
  }

  export const Document: Constructable<unknown>
  export const SignHere: Constructable<unknown>
  export const Signer: Constructable<unknown>
  export const Tabs: Constructable<unknown>
  export const Recipients: Constructable<unknown>
  export const EnvelopeDefinition: Constructable<unknown>
  export const RecipientViewRequest: Constructable<unknown>

  export class EnvelopesApi {
    constructor(client: ApiClient)
    createEnvelope(
      accountId: string,
      opts: { envelopeDefinition: unknown },
    ): Promise<{ envelopeId: string; status?: string }>
    createRecipientView(
      accountId: string,
      envelopeId: string,
      opts: { recipientViewRequest: unknown },
    ): Promise<{ url: string }>
  }

  const _default: {
    ApiClient: typeof ApiClient
    EnvelopesApi: typeof EnvelopesApi
    Document: typeof Document
    SignHere: typeof SignHere
    Signer: typeof Signer
    Tabs: typeof Tabs
    Recipients: typeof Recipients
    EnvelopeDefinition: typeof EnvelopeDefinition
    RecipientViewRequest: typeof RecipientViewRequest
  }
  export default _default
}
