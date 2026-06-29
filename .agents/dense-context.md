# 🧠 Antigravity Dense Context Bundle
## 📜 Core Types (Byznysový slovník)
### `spine/domain/core-types/index.ts`
```typescript
export * from './schemas';
export * from './listing.dto';
```
### `spine/domain/core-types/listing.dto.ts`
```typescript
import { z } from 'zod';
export const RawListingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(3, "Název inzerátu musí mít alespoň 3 znaky"),
  price: z.number().nonnegative("Cena nesmí být záporná"),
  sourceUrl: z.string().url("Neplatná URL inzerátu"),
  // Volitelná pole pro extrakci z LLM
  mileage: z.number().optional(),
  year: z.number().optional(),
});
export type RawListing = z.infer<typeof RawListingSchema>;
```
### `spine/domain/core-types/schemas.ts`
```typescript
import { z } from 'zod';
/**
 * @terminology ArbitrageOpportunity
 * Reprezentuje nalezenou příležitost na trhu (inzerát), kde 
 * odhadovaná hodnota od LLM je výrazně vyšší než nabízená cena.
 */
export const ArbitrageOpportunitySchema = z.object({
  id: z.string().describe("Interní unikátní ID v systému"),
  assetId: z.string().describe("Původní ID na inzertním portálu"),
  expectedProfit: z.number().positive().describe("Očekávaný hrubý zisk v CZK"),
  metadata: z.record(z.any()).describe("Doplňující data o inzerátu (url, title, atd.)")
});
export type ArbitrageOpportunity = z.infer<typeof ArbitrageOpportunitySchema>;
/**
 * @terminology ShadowDraft
 * Rozpracovaný, neviditelný návrh inzerátu vytvořený naší Levou hemisférou.
 * Prodejce ho uvidí až po kliknutí na Magic Link.
 */
export const ShadowDraftSchema = z.object({
  draftId: z.string(),
  contact: z.string(),
  createdAt: z.string().datetime(),
  status: z.enum(['pending', 'claimed', 'expired'])
});
export type ShadowDraft = z.infer<typeof ShadowDraftSchema>;
```
## 🔌 Veřejné kontrakty uzlů (Node Boundaries)
### `spine/acquisition/scrapers/node_modules/@anthropic-ai/sdk/src/helpers/index.ts`
```typescript
export { jsonSchemaOutputFormat } from './json-schema';
export { zodOutputFormat } from './zod';
```
### `spine/acquisition/scrapers/node_modules/@anthropic-ai/sdk/src/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export { Anthropic as default } from './client';
export { type Uploadable, toFile } from './core/uploads';
export { APIPromise } from './core/api-promise';
export { BaseAnthropic, Anthropic, type ClientOptions, HUMAN_PROMPT, AI_PROMPT } from './client';
export { PagePromise } from './core/pagination';
export {
  AnthropicError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  BadRequestError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  UnprocessableEntityError,
} from './core/error';
export type {
  AutoParseableOutputFormat,
  ParsedMessage,
  ParsedContentBlock,
  ParseableMessageCreateParams,
  ExtractParsedContentFromParams,
} from './lib/parser';
```
### `spine/acquisition/scrapers/node_modules/@anthropic-ai/sdk/src/resources/beta/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Beta,
  type AnthropicBeta,
  type BetaAPIError,
  type BetaAuthenticationError,
  type BetaBillingError,
  type BetaError,
  type BetaErrorResponse,
  type BetaGatewayTimeoutError,
  type BetaInvalidRequestError,
  type BetaNotFoundError,
  type BetaOverloadedError,
  type BetaPermissionError,
  type BetaRateLimitError,
} from './beta';
export {
  Files,
  type DeletedFile,
  type FileMetadata,
  type FileListParams,
  type FileDeleteParams,
  type FileDownloadParams,
  type FileRetrieveMetadataParams,
  type FileUploadParams,
  type FileMetadataPage,
} from './files';
export {
  Messages,
  type BetaAllThinkingTurns,
  type BetaBase64ImageSource,
  type BetaBase64PDFSource,
  type BetaBashCodeExecutionOutputBlock,
  type BetaBashCodeExecutionOutputBlockParam,
  type BetaBashCodeExecutionResultBlock,
  type BetaBashCodeExecutionResultBlockParam,
  type BetaBashCodeExecutionToolResultBlock,
  type BetaBashCodeExecutionToolResultBlockParam,
  type BetaBashCodeExecutionToolResultError,
  type BetaBashCodeExecutionToolResultErrorParam,
  type BetaCacheControlEphemeral,
  type BetaCacheCreation,
  type BetaCitationCharLocation,
  type BetaCitationCharLocationParam,
  type BetaCitationConfig,
  type BetaCitationContentBlockLocation,
  type BetaCitationContentBlockLocationParam,
  type BetaCitationPageLocation,
  type BetaCitationPageLocationParam,
  type BetaCitationSearchResultLocation,
  type BetaCitationSearchResultLocationParam,
  type BetaCitationWebSearchResultLocationParam,
  type BetaCitationsConfigParam,
  type BetaCitationsDelta,
  type BetaCitationsWebSearchResultLocation,
  type BetaClearThinking20251015Edit,
  type BetaClearThinking20251015EditResponse,
  type BetaClearToolUses20250919Edit,
  type BetaClearToolUses20250919EditResponse,
  type BetaCodeExecutionOutputBlock,
  type BetaCodeExecutionOutputBlockParam,
  type BetaCodeExecutionResultBlock,
  type BetaCodeExecutionResultBlockParam,
  type BetaCodeExecutionTool20250522,
  type BetaCodeExecutionTool20250825,
  type BetaCodeExecutionTool20260120,
  type BetaCodeExecutionToolResultBlock,
  type BetaCodeExecutionToolResultBlockContent,
  type BetaCodeExecutionToolResultBlockParam,
  type BetaCodeExecutionToolResultBlockParamContent,
  type BetaCodeExecutionToolResultError,
  type BetaCodeExecutionToolResultErrorCode,
  type BetaCodeExecutionToolResultErrorParam,
  type BetaCompact20260112Edit,
  type BetaCompactionBlock,
  type BetaCompactionBlockParam,
  type BetaCompactionContentBlockDelta,
  type BetaCompactionIterationUsage,
  type BetaContainer,
  type BetaContainerParams,
  type BetaContainerUploadBlock,
  type BetaContainerUploadBlockParam,
  type BetaContentBlock,
  type BetaContentBlockParam,
  type BetaContentBlockSource,
  type BetaContentBlockSourceContent,
  type BetaContextManagementConfig,
  type BetaContextManagementResponse,
  type BetaCountTokensContextManagementResponse,
  type BetaDirectCaller,
  type BetaDocumentBlock,
  type BetaEncryptedCodeExecutionResultBlock,
  type BetaEncryptedCodeExecutionResultBlockParam,
  type BetaFileDocumentSource,
  type BetaFileImageSource,
  type BetaImageBlockParam,
  type BetaInputJSONDelta,
  type BetaInputTokensClearAtLeast,
  type BetaInputTokensTrigger,
  type BetaJSONOutputFormat,
  type BetaMCPToolConfig,
  type BetaMCPToolDefaultConfig,
  type BetaMCPToolResultBlock,
  type BetaMCPToolUseBlock,
  type BetaMCPToolUseBlockParam,
  type BetaMCPToolset,
  type BetaMemoryTool20250818,
  type BetaMemoryTool20250818Command,
  type BetaMemoryTool20250818CreateCommand,
  type BetaMemoryTool20250818DeleteCommand,
  type BetaMemoryTool20250818InsertCommand,
  type BetaMemoryTool20250818RenameCommand,
  type BetaMemoryTool20250818StrReplaceCommand,
  type BetaMemoryTool20250818ViewCommand,
  type BetaMessage,
  type BetaMessageDeltaUsage,
  type BetaMessageIterationUsage,
  type BetaMessageParam,
  type BetaMessageTokensCount,
  type BetaMetadata,
  type BetaOutputConfig,
  type BetaPlainTextSource,
  type BetaRawContentBlockDelta,
  type BetaRawContentBlockDeltaEvent,
  type BetaRawContentBlockStartEvent,
  type BetaRawContentBlockStopEvent,
  type BetaRawMessageDeltaEvent,
  type BetaRawMessageStartEvent,
  type BetaRawMessageStopEvent,
  type BetaRawMessageStreamEvent,
  type BetaRedactedThinkingBlock,
  type BetaRedactedThinkingBlockParam,
  type BetaRequestDocumentBlock,
  type BetaRequestMCPServerToolConfiguration,
  type BetaRequestMCPServerURLDefinition,
  type BetaRequestMCPToolResultBlockParam,
  type BetaSearchResultBlockParam,
  type BetaServerToolCaller,
  type BetaServerToolCaller20260120,
  type BetaServerToolUsage,
  type BetaServerToolUseBlock,
  type BetaServerToolUseBlockParam,
  type BetaSignatureDelta,
  type BetaSkill,
  type BetaSkillParams,
  type BetaStopReason,
  type BetaTextBlock,
  type BetaTextBlockParam,
  type BetaTextCitation,
  type BetaTextCitationParam,
  type BetaTextDelta,
  type BetaTextEditorCodeExecutionCreateResultBlock,
  type BetaTextEditorCodeExecutionCreateResultBlockParam,
  type BetaTextEditorCodeExecutionStrReplaceResultBlock,
  type BetaTextEditorCodeExecutionStrReplaceResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultBlock,
  type BetaTextEditorCodeExecutionToolResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultError,
  type BetaTextEditorCodeExecutionToolResultErrorParam,
  type BetaTextEditorCodeExecutionViewResultBlock,
  type BetaTextEditorCodeExecutionViewResultBlockParam,
  type BetaThinkingBlock,
  type BetaThinkingBlockParam,
  type BetaThinkingConfigAdaptive,
  type BetaThinkingConfigDisabled,
  type BetaThinkingConfigEnabled,
  type BetaThinkingConfigParam,
  type BetaThinkingDelta,
  type BetaThinkingTurns,
  type BetaTool,
  type BetaToolBash20241022,
  type BetaToolBash20250124,
  type BetaToolChoice,
  type BetaToolChoiceAny,
  type BetaToolChoiceAuto,
  type BetaToolChoiceNone,
  type BetaToolChoiceTool,
  type BetaToolComputerUse20241022,
  type BetaToolComputerUse20250124,
  type BetaToolComputerUse20251124,
  type BetaToolReferenceBlock,
  type BetaToolReferenceBlockParam,
  type BetaToolResultBlockParam,
  type BetaToolSearchToolBm25_20251119,
  type BetaToolSearchToolRegex20251119,
  type BetaToolSearchToolResultBlock,
  type BetaToolSearchToolResultBlockParam,
  type BetaToolSearchToolResultError,
  type BetaToolSearchToolResultErrorParam,
  type BetaToolSearchToolSearchResultBlock,
  type BetaToolSearchToolSearchResultBlockParam,
  type BetaToolTextEditor20241022,
  type BetaToolTextEditor20250124,
  type BetaToolTextEditor20250429,
  type BetaToolTextEditor20250728,
  type BetaToolUnion,
  type BetaToolUseBlock,
  type BetaToolUseBlockParam,
  type BetaToolUsesKeep,
  type BetaToolUsesTrigger,
  type BetaURLImageSource,
  type BetaURLPDFSource,
  type BetaUsage,
  type BetaUserLocation,
  type BetaWebFetchBlock,
  type BetaWebFetchBlockParam,
  type BetaWebFetchTool20250910,
  type BetaWebFetchTool20260209,
  type BetaWebFetchToolResultBlock,
  type BetaWebFetchToolResultBlockParam,
  type BetaWebFetchToolResultErrorBlock,
  type BetaWebFetchToolResultErrorBlockParam,
  type BetaWebFetchToolResultErrorCode,
  type BetaWebSearchResultBlock,
  type BetaWebSearchResultBlockParam,
  type BetaWebSearchTool20250305,
  type BetaWebSearchTool20260209,
  type BetaWebSearchToolRequestError,
  type BetaWebSearchToolResultBlock,
  type BetaWebSearchToolResultBlockContent,
  type BetaWebSearchToolResultBlockParam,
  type BetaWebSearchToolResultBlockParamContent,
  type BetaWebSearchToolResultError,
  type BetaWebSearchToolResultErrorCode,
  type BetaBase64PDFBlock,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
  type BetaToolResultContentBlockParam,
} from './messages/index';
export {
  Models,
  type BetaModelInfo,
  type ModelRetrieveParams,
  type ModelListParams,
  type BetaModelInfosPage,
} from './models';
export {
  Skills,
  type SkillCreateResponse,
  type SkillRetrieveResponse,
  type SkillListResponse,
  type SkillDeleteResponse,
  type SkillCreateParams,
  type SkillRetrieveParams,
  type SkillListParams,
  type SkillDeleteParams,
  type SkillListResponsesPageCursor,
} from './skills/index';
```
### `spine/acquisition/scrapers/node_modules/@anthropic-ai/sdk/src/resources/beta/messages/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Batches,
  type BetaDeletedMessageBatch,
  type BetaMessageBatch,
  type BetaMessageBatchCanceledResult,
  type BetaMessageBatchErroredResult,
  type BetaMessageBatchExpiredResult,
  type BetaMessageBatchIndividualResponse,
  type BetaMessageBatchRequestCounts,
  type BetaMessageBatchResult,
  type BetaMessageBatchSucceededResult,
  type BatchCreateParams,
  type BatchRetrieveParams,
  type BatchListParams,
  type BatchDeleteParams,
  type BatchCancelParams,
  type BatchResultsParams,
  type BetaMessageBatchesPage,
} from './batches';
export {
  Messages,
  type BetaAllThinkingTurns,
  type BetaBase64ImageSource,
  type BetaBase64PDFSource,
  type BetaBashCodeExecutionOutputBlock,
  type BetaBashCodeExecutionOutputBlockParam,
  type BetaBashCodeExecutionResultBlock,
  type BetaBashCodeExecutionResultBlockParam,
  type BetaBashCodeExecutionToolResultBlock,
  type BetaBashCodeExecutionToolResultBlockParam,
  type BetaBashCodeExecutionToolResultError,
  type BetaBashCodeExecutionToolResultErrorParam,
  type BetaCacheControlEphemeral,
  type BetaCacheCreation,
  type BetaCitationCharLocation,
  type BetaCitationCharLocationParam,
  type BetaCitationConfig,
  type BetaCitationContentBlockLocation,
  type BetaCitationContentBlockLocationParam,
  type BetaCitationPageLocation,
  type BetaCitationPageLocationParam,
  type BetaCitationSearchResultLocation,
  type BetaCitationSearchResultLocationParam,
  type BetaCitationWebSearchResultLocationParam,
  type BetaCitationsConfigParam,
  type BetaCitationsDelta,
  type BetaCitationsWebSearchResultLocation,
  type BetaClearThinking20251015Edit,
  type BetaClearThinking20251015EditResponse,
  type BetaClearToolUses20250919Edit,
  type BetaClearToolUses20250919EditResponse,
  type BetaCodeExecutionOutputBlock,
  type BetaCodeExecutionOutputBlockParam,
  type BetaCodeExecutionResultBlock,
  type BetaCodeExecutionResultBlockParam,
  type BetaCodeExecutionTool20250522,
  type BetaCodeExecutionTool20250825,
  type BetaCodeExecutionTool20260120,
  type BetaCodeExecutionToolResultBlock,
  type BetaCodeExecutionToolResultBlockContent,
  type BetaCodeExecutionToolResultBlockParam,
  type BetaCodeExecutionToolResultBlockParamContent,
  type BetaCodeExecutionToolResultError,
  type BetaCodeExecutionToolResultErrorCode,
  type BetaCodeExecutionToolResultErrorParam,
  type BetaCompact20260112Edit,
  type BetaCompactionBlock,
  type BetaCompactionBlockParam,
  type BetaCompactionContentBlockDelta,
  type BetaCompactionIterationUsage,
  type BetaContainer,
  type BetaContainerParams,
  type BetaContainerUploadBlock,
  type BetaContainerUploadBlockParam,
  type BetaContentBlock,
  type BetaContentBlockParam,
  type BetaContentBlockSource,
  type BetaContentBlockSourceContent,
  type BetaContextManagementConfig,
  type BetaContextManagementResponse,
  type BetaCountTokensContextManagementResponse,
  type BetaDirectCaller,
  type BetaDocumentBlock,
  type BetaEncryptedCodeExecutionResultBlock,
  type BetaEncryptedCodeExecutionResultBlockParam,
  type BetaFileDocumentSource,
  type BetaFileImageSource,
  type BetaImageBlockParam,
  type BetaInputJSONDelta,
  type BetaInputTokensClearAtLeast,
  type BetaInputTokensTrigger,
  type BetaJSONOutputFormat,
  type BetaMCPToolResultBlock,
  type BetaMCPToolUseBlock,
  type BetaMCPToolUseBlockParam,
  type BetaMCPToolset,
  type BetaMemoryTool20250818,
  type BetaMemoryTool20250818Command,
  type BetaMemoryTool20250818CreateCommand,
  type BetaMemoryTool20250818DeleteCommand,
  type BetaMemoryTool20250818InsertCommand,
  type BetaMemoryTool20250818RenameCommand,
  type BetaMemoryTool20250818StrReplaceCommand,
  type BetaMemoryTool20250818ViewCommand,
  type BetaMessage,
  type BetaMessageDeltaUsage,
  type BetaMessageIterationUsage,
  type BetaMessageParam,
  type BetaMessageTokensCount,
  type BetaMetadata,
  type BetaOutputConfig,
  type BetaPlainTextSource,
  type BetaRawContentBlockDelta,
  type BetaRawContentBlockDeltaEvent,
  type BetaRawContentBlockStartEvent,
  type BetaRawContentBlockStopEvent,
  type BetaRawMessageDeltaEvent,
  type BetaRawMessageStartEvent,
  type BetaRawMessageStopEvent,
  type BetaRawMessageStreamEvent,
  type BetaRedactedThinkingBlock,
  type BetaRedactedThinkingBlockParam,
  type BetaRequestDocumentBlock,
  type BetaRequestMCPServerToolConfiguration,
  type BetaRequestMCPServerURLDefinition,
  type BetaRequestMCPToolResultBlockParam,
  type BetaSearchResultBlockParam,
  type BetaServerToolCaller,
  type BetaServerToolCaller20260120,
  type BetaServerToolUsage,
  type BetaServerToolUseBlock,
  type BetaServerToolUseBlockParam,
  type BetaSignatureDelta,
  type BetaSkill,
  type BetaSkillParams,
  type BetaStopReason,
  type BetaTextBlock,
  type BetaTextBlockParam,
  type BetaTextCitation,
  type BetaTextCitationParam,
  type BetaTextDelta,
  type BetaTextEditorCodeExecutionCreateResultBlock,
  type BetaTextEditorCodeExecutionCreateResultBlockParam,
  type BetaTextEditorCodeExecutionStrReplaceResultBlock,
  type BetaTextEditorCodeExecutionStrReplaceResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultBlock,
  type BetaTextEditorCodeExecutionToolResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultError,
  type BetaTextEditorCodeExecutionToolResultErrorParam,
  type BetaTextEditorCodeExecutionViewResultBlock,
  type BetaTextEditorCodeExecutionViewResultBlockParam,
  type BetaThinkingBlock,
  type BetaThinkingBlockParam,
  type BetaThinkingConfigAdaptive,
  type BetaThinkingConfigDisabled,
  type BetaThinkingConfigEnabled,
  type BetaThinkingConfigParam,
  type BetaThinkingDelta,
  type BetaThinkingTurns,
  type BetaTool,
  type BetaToolBash20241022,
  type BetaToolBash20250124,
  type BetaToolChoice,
  type BetaToolChoiceAny,
  type BetaToolChoiceAuto,
  type BetaToolChoiceNone,
  type BetaToolChoiceTool,
  type BetaToolComputerUse20241022,
  type BetaToolComputerUse20250124,
  type BetaToolComputerUse20251124,
  type BetaToolReferenceBlock,
  type BetaToolReferenceBlockParam,
  type BetaToolResultBlockParam,
  type BetaToolTextEditor20241022,
  type BetaToolTextEditor20250124,
  type BetaToolTextEditor20250429,
  type BetaToolTextEditor20250728,
  type BetaToolUnion,
  type BetaToolUseBlock,
  type BetaToolUseBlockParam,
  type BetaToolUsesKeep,
  type BetaToolUsesTrigger,
  type BetaURLImageSource,
  type BetaURLPDFSource,
  type BetaUsage,
  type BetaUserLocation,
  type BetaWebFetchBlock,
  type BetaWebFetchBlockParam,
  type BetaWebFetchTool20250910,
  type BetaWebFetchTool20260209,
  type BetaWebFetchToolResultBlock,
  type BetaWebFetchToolResultBlockParam,
  type BetaWebFetchToolResultErrorBlock,
  type BetaWebFetchToolResultErrorBlockParam,
  type BetaWebFetchToolResultErrorCode,
  type BetaWebSearchResultBlock,
  type BetaWebSearchResultBlockParam,
  type BetaWebSearchTool20250305,
  type BetaWebSearchTool20260209,
  type BetaWebSearchToolRequestError,
  type BetaWebSearchToolResultBlock,
  type BetaWebSearchToolResultBlockContent,
  type BetaWebSearchToolResultBlockParam,
  type BetaWebSearchToolResultBlockParamContent,
  type BetaWebSearchToolResultError,
  type BetaWebSearchToolResultErrorCode,
  type BetaBase64PDFBlock,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
  type BetaMessageStreamParams,
  type BetaToolSearchToolBm25_20251119,
  type BetaToolSearchToolRegex20251119,
  type BetaToolSearchToolResultBlock,
  type BetaToolSearchToolResultBlockParam,
  type BetaToolSearchToolResultError,
  type BetaToolSearchToolResultErrorParam,
  type BetaToolSearchToolSearchResultBlock,
  type BetaToolSearchToolSearchResultBlockParam,
  type BetaMCPToolConfig,
  type BetaMCPToolDefaultConfig,
  type BetaToolResultContentBlockParam,
} from './messages';
export { BetaToolRunner, type BetaToolRunnerParams, ToolError } from './messages';
```
### `spine/acquisition/scrapers/node_modules/@anthropic-ai/sdk/src/resources/beta/skills/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Skills,
  type SkillCreateResponse,
  type SkillRetrieveResponse,
  type SkillListResponse,
  type SkillDeleteResponse,
  type SkillCreateParams,
  type SkillRetrieveParams,
  type SkillListParams,
  type SkillDeleteParams,
  type SkillListResponsesPageCursor,
} from './skills';
export {
  Versions,
  type VersionCreateResponse,
  type VersionRetrieveResponse,
  type VersionListResponse,
  type VersionDeleteResponse,
  type VersionCreateParams,
  type VersionRetrieveParams,
  type VersionListParams,
  type VersionDeleteParams,
  type VersionListResponsesPageCursor,
} from './versions';
```
### `spine/acquisition/scrapers/node_modules/@anthropic-ai/sdk/src/resources/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export * from './shared';
export {
  Beta,
  type AnthropicBeta,
  type BetaAPIError,
  type BetaAuthenticationError,
  type BetaBillingError,
  type BetaError,
  type BetaErrorResponse,
  type BetaGatewayTimeoutError,
  type BetaInvalidRequestError,
  type BetaNotFoundError,
  type BetaOverloadedError,
  type BetaPermissionError,
  type BetaRateLimitError,
} from './beta/beta';
export {
  Completions,
  type Completion,
  type CompletionCreateParams,
  type CompletionCreateParamsNonStreaming,
  type CompletionCreateParamsStreaming,
} from './completions';
export {
  Messages,
  type Base64ImageSource,
  type Base64PDFSource,
  type BashCodeExecutionOutputBlock,
  type BashCodeExecutionOutputBlockParam,
  type BashCodeExecutionResultBlock,
  type BashCodeExecutionResultBlockParam,
  type BashCodeExecutionToolResultBlock,
  type BashCodeExecutionToolResultBlockParam,
  type BashCodeExecutionToolResultError,
  type BashCodeExecutionToolResultErrorCode,
  type BashCodeExecutionToolResultErrorParam,
  type CacheControlEphemeral,
  type CacheCreation,
  type CitationCharLocation,
  type CitationCharLocationParam,
  type CitationContentBlockLocation,
  type CitationContentBlockLocationParam,
  type CitationPageLocation,
  type CitationPageLocationParam,
  type CitationSearchResultLocationParam,
  type CitationWebSearchResultLocationParam,
  type CitationsConfig,
  type CitationsConfigParam,
  type CitationsDelta,
  type CitationsSearchResultLocation,
  type CitationsWebSearchResultLocation,
  type CodeExecutionOutputBlock,
  type CodeExecutionOutputBlockParam,
  type CodeExecutionResultBlock,
  type CodeExecutionResultBlockParam,
  type CodeExecutionTool20250522,
  type CodeExecutionTool20250825,
  type CodeExecutionTool20260120,
  type CodeExecutionToolResultBlock,
  type CodeExecutionToolResultBlockContent,
  type CodeExecutionToolResultBlockParam,
  type CodeExecutionToolResultBlockParamContent,
  type CodeExecutionToolResultError,
  type CodeExecutionToolResultErrorCode,
  type CodeExecutionToolResultErrorParam,
  type Container,
  type ContainerUploadBlock,
  type ContainerUploadBlockParam,
  type ContentBlock,
  type ContentBlockParam,
  type ContentBlockStartEvent,
  type ContentBlockStopEvent,
  type ContentBlockSource,
  type ContentBlockSourceContent,
  type DirectCaller,
  type DocumentBlock,
  type DocumentBlockParam,
  type EncryptedCodeExecutionResultBlock,
  type EncryptedCodeExecutionResultBlockParam,
  type ImageBlockParam,
  type InputJSONDelta,
  type JSONOutputFormat,
  type MemoryTool20250818,
  type Message,
  type MessageCountTokensTool,
  type MessageDeltaEvent,
  type MessageDeltaUsage,
  type MessageParam,
  type MessageStreamParams,
  type MessageTokensCount,
  type Metadata,
  type Model,
  type OutputConfig,
  type PlainTextSource,
  type RawContentBlockDelta,
  type RawContentBlockDeltaEvent,
  type RawContentBlockStartEvent,
  type RawContentBlockStopEvent,
  type RawMessageDeltaEvent,
  type RawMessageStartEvent,
  type RawMessageStopEvent,
  type RawMessageStreamEvent,
  type RedactedThinkingBlock,
  type RedactedThinkingBlockParam,
  type SearchResultBlockParam,
  type ServerToolCaller,
  type ServerToolCaller20260120,
  type ServerToolUsage,
  type ServerToolUseBlock,
  type ServerToolUseBlockParam,
  type SignatureDelta,
  type StopReason,
  type TextBlock,
  type TextBlockParam,
  type TextCitation,
  type TextCitationParam,
  type TextDelta,
  type TextEditorCodeExecutionCreateResultBlock,
  type TextEditorCodeExecutionCreateResultBlockParam,
  type TextEditorCodeExecutionStrReplaceResultBlock,
  type TextEditorCodeExecutionStrReplaceResultBlockParam,
  type TextEditorCodeExecutionToolResultBlock,
  type TextEditorCodeExecutionToolResultBlockParam,
  type TextEditorCodeExecutionToolResultError,
  type TextEditorCodeExecutionToolResultErrorCode,
  type TextEditorCodeExecutionToolResultErrorParam,
  type TextEditorCodeExecutionViewResultBlock,
  type TextEditorCodeExecutionViewResultBlockParam,
  type ThinkingBlock,
  type ThinkingBlockParam,
  type ThinkingConfigAdaptive,
  type ThinkingConfigDisabled,
  type ThinkingConfigEnabled,
  type ThinkingConfigParam,
  type ThinkingDelta,
  type Tool,
  type ToolBash20250124,
  type ToolChoice,
  type ToolChoiceAny,
  type ToolChoiceAuto,
  type ToolChoiceNone,
  type ToolChoiceTool,
  type ToolReferenceBlock,
  type ToolReferenceBlockParam,
  type ToolResultBlockParam,
  type ToolSearchToolBm25_20251119,
  type ToolSearchToolRegex20251119,
  type ToolSearchToolResultBlock,
  type ToolSearchToolResultBlockParam,
  type ToolSearchToolResultError,
  type ToolSearchToolResultErrorCode,
  type ToolSearchToolResultErrorParam,
  type ToolSearchToolSearchResultBlock,
  type ToolSearchToolSearchResultBlockParam,
  type ToolTextEditor20250124,
  type ToolTextEditor20250429,
  type ToolTextEditor20250728,
  type ToolUnion,
  type ToolUseBlock,
  type ToolUseBlockParam,
  type URLImageSource,
  type URLPDFSource,
  type Usage,
  type UserLocation,
  type WebFetchBlock,
  type WebFetchBlockParam,
  type WebFetchTool20250910,
  type WebFetchTool20260209,
  type WebFetchToolResultBlock,
  type WebFetchToolResultBlockParam,
  type WebFetchToolResultErrorBlock,
  type WebFetchToolResultErrorBlockParam,
  type WebFetchToolResultErrorCode,
  type WebSearchResultBlock,
  type WebSearchResultBlockParam,
  type WebSearchTool20250305,
  type WebSearchTool20260209,
  type WebSearchToolRequestError,
  type WebSearchToolResultBlock,
  type WebSearchToolResultBlockContent,
  type WebSearchToolResultBlockParam,
  type WebSearchToolResultBlockParamContent,
  type WebSearchToolResultError,
  type WebSearchToolResultErrorCode,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
} from './messages/messages';
export {
  Models,
  type ModelInfo,
  type ModelRetrieveParams,
  type ModelListParams,
  type ModelInfosPage,
} from './models';
```
### `spine/acquisition/scrapers/node_modules/@anthropic-ai/sdk/src/resources/messages/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Batches,
  type DeletedMessageBatch,
  type MessageBatch,
  type MessageBatchCanceledResult,
  type MessageBatchErroredResult,
  type MessageBatchExpiredResult,
  type MessageBatchIndividualResponse,
  type MessageBatchRequestCounts,
  type MessageBatchResult,
  type MessageBatchSucceededResult,
  type BatchCreateParams,
  type BatchListParams,
  type MessageBatchesPage,
} from './batches';
export {
  Messages,
  type Base64ImageSource,
  type Base64PDFSource,
  type BashCodeExecutionOutputBlock,
  type BashCodeExecutionOutputBlockParam,
  type BashCodeExecutionResultBlock,
  type BashCodeExecutionResultBlockParam,
  type BashCodeExecutionToolResultBlock,
  type BashCodeExecutionToolResultBlockParam,
  type BashCodeExecutionToolResultError,
  type BashCodeExecutionToolResultErrorCode,
  type BashCodeExecutionToolResultErrorParam,
  type CacheControlEphemeral,
  type CacheCreation,
  type CitationCharLocation,
  type CitationCharLocationParam,
  type CitationContentBlockLocation,
  type CitationContentBlockLocationParam,
  type CitationPageLocation,
  type CitationPageLocationParam,
  type CitationSearchResultLocationParam,
  type CitationWebSearchResultLocationParam,
  type CitationsConfig,
  type CitationsConfigParam,
  type CitationsDelta,
  type CitationsSearchResultLocation,
  type CitationsWebSearchResultLocation,
  type CodeExecutionOutputBlock,
  type CodeExecutionOutputBlockParam,
  type CodeExecutionResultBlock,
  type CodeExecutionResultBlockParam,
  type CodeExecutionTool20250522,
  type CodeExecutionTool20250825,
  type CodeExecutionTool20260120,
  type CodeExecutionToolResultBlock,
  type CodeExecutionToolResultBlockContent,
  type CodeExecutionToolResultBlockParam,
  type CodeExecutionToolResultBlockParamContent,
  type CodeExecutionToolResultError,
  type CodeExecutionToolResultErrorCode,
  type CodeExecutionToolResultErrorParam,
  type Container,
  type ContainerUploadBlock,
  type ContainerUploadBlockParam,
  type ContentBlock,
  type ContentBlockParam,
  type ContentBlockStartEvent,
  type ContentBlockStopEvent,
  type ContentBlockSource,
  type ContentBlockSourceContent,
  type DirectCaller,
  type DocumentBlock,
  type DocumentBlockParam,
  type EncryptedCodeExecutionResultBlock,
  type EncryptedCodeExecutionResultBlockParam,
  type ImageBlockParam,
  type InputJSONDelta,
  type JSONOutputFormat,
  type MemoryTool20250818,
  type Message,
  type MessageCountTokensTool,
  type MessageDeltaEvent,
  type MessageDeltaUsage,
  type MessageParam,
  type MessageTokensCount,
  type Metadata,
  type Model,
  type OutputConfig,
  type PlainTextSource,
  type RawContentBlockDelta,
  type RawContentBlockDeltaEvent,
  type RawContentBlockStartEvent,
  type RawContentBlockStopEvent,
  type RawMessageDeltaEvent,
  type RawMessageStartEvent,
  type RawMessageStopEvent,
  type RawMessageStreamEvent,
  type RedactedThinkingBlock,
  type RedactedThinkingBlockParam,
  type SearchResultBlockParam,
  type ServerToolCaller,
  type ServerToolCaller20260120,
  type ServerToolUsage,
  type ServerToolUseBlock,
  type ServerToolUseBlockParam,
  type SignatureDelta,
  type StopReason,
  type TextBlock,
  type TextBlockParam,
  type TextCitation,
  type TextCitationParam,
  type TextDelta,
  type TextEditorCodeExecutionCreateResultBlock,
  type TextEditorCodeExecutionCreateResultBlockParam,
  type TextEditorCodeExecutionStrReplaceResultBlock,
  type TextEditorCodeExecutionStrReplaceResultBlockParam,
  type TextEditorCodeExecutionToolResultBlock,
  type TextEditorCodeExecutionToolResultBlockParam,
  type TextEditorCodeExecutionToolResultError,
  type TextEditorCodeExecutionToolResultErrorCode,
  type TextEditorCodeExecutionToolResultErrorParam,
  type TextEditorCodeExecutionViewResultBlock,
  type TextEditorCodeExecutionViewResultBlockParam,
  type ThinkingBlock,
  type ThinkingBlockParam,
  type ThinkingConfigAdaptive,
  type ThinkingConfigDisabled,
  type ThinkingConfigEnabled,
  type ThinkingConfigParam,
  type ThinkingDelta,
  type Tool,
  type ToolBash20250124,
  type ToolChoice,
  type ToolChoiceAny,
  type ToolChoiceAuto,
  type ToolChoiceNone,
  type ToolChoiceTool,
  type ToolReferenceBlock,
  type ToolReferenceBlockParam,
  type ToolResultBlockParam,
  type ToolSearchToolBm25_20251119,
  type ToolSearchToolRegex20251119,
  type ToolSearchToolResultBlock,
  type ToolSearchToolResultBlockParam,
  type ToolSearchToolResultError,
  type ToolSearchToolResultErrorCode,
  type ToolSearchToolResultErrorParam,
  type ToolSearchToolSearchResultBlock,
  type ToolSearchToolSearchResultBlockParam,
  type ToolTextEditor20250124,
  type ToolTextEditor20250429,
  type ToolTextEditor20250728,
  type ToolUnion,
  type ToolUseBlock,
  type ToolUseBlockParam,
  type URLImageSource,
  type URLPDFSource,
  type Usage,
  type UserLocation,
  type WebFetchBlock,
  type WebFetchBlockParam,
  type WebFetchTool20250910,
  type WebFetchTool20260209,
  type WebFetchToolResultBlock,
  type WebFetchToolResultBlockParam,
  type WebFetchToolResultErrorBlock,
  type WebFetchToolResultErrorBlockParam,
  type WebFetchToolResultErrorCode,
  type WebSearchResultBlock,
  type WebSearchResultBlockParam,
  type WebSearchTool20250305,
  type WebSearchTool20260209,
  type WebSearchToolRequestError,
  type WebSearchToolResultBlock,
  type WebSearchToolResultBlockContent,
  type WebSearchToolResultBlockParam,
  type WebSearchToolResultBlockParamContent,
  type WebSearchToolResultError,
  type WebSearchToolResultErrorCode,
  type MessageStreamEvent,
  type MessageStartEvent,
  type MessageStopEvent,
  type ContentBlockDeltaEvent,
  type MessageCreateParams,
  type MessageCreateParamsBase,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
} from './messages';
```
### `spine/acquisition/scrapers/node_modules/cheerio/src/index.ts`
```typescript
/**
 * @file Batteries-included version of Cheerio. This module includes several
 *   convenience methods for loading documents from various sources.
 */
export * from './load-parse.js';
export { contains, merge } from './static.js';
export type * from './types.js';
export type {
  Cheerio,
  CheerioAPI,
  CheerioOptions,
  HTMLParser2Options,
} from './slim.js';
import { adapter as htmlparser2Adapter } from 'parse5-htmlparser2-tree-adapter';
import * as htmlparser2 from 'htmlparser2';
import { ParserStream as Parse5Stream } from 'parse5-parser-stream';
import {
  decodeBuffer,
  DecodeStream,
  type SnifferOptions,
} from 'encoding-sniffer';
import * as undici from 'undici';
import MIMEType from 'whatwg-mimetype';
import { Writable, finished } from 'node:stream';
import type { CheerioAPI } from './load.js';
import {
  flattenOptions,
  type InternalOptions,
  type CheerioOptions,
} from './options.js';
import { load } from './load-parse.js';
/**
 * Sniffs the encoding of a buffer, then creates a querying function bound to a
 * document created from the buffer.
 *
 * @category Loading
 * @example
 *
 * ```js
 * import * as cheerio from 'cheerio';
 *
 * const buffer = fs.readFileSync('index.html');
 * const $ = cheerio.loadBuffer(buffer);
 * ```
 *
 * @param buffer - The buffer to sniff the encoding of.
 * @param options - The options to pass to Cheerio.
 * @returns The loaded document.
 */
export function loadBuffer(
  buffer: Buffer,
  options: DecodeStreamOptions = {},
): CheerioAPI {
  const opts = flattenOptions(options);
  const str = decodeBuffer(buffer, {
    defaultEncoding: opts?.xmlMode ? 'utf8' : 'windows-1252',
    ...options.encoding,
  });
  return load(str, opts);
}
function _stringStream(
  options: InternalOptions | undefined,
  cb: (err: Error | null | undefined, $: CheerioAPI) => void,
): Writable {
  if (options?._useHtmlParser2) {
    const parser = htmlparser2.createDocumentStream(
      (err, document) => cb(err, load(document, options)),
      options,
    );
    return new Writable({
      decodeStrings: false,
      write(chunk, _encoding, callback) {
        if (typeof chunk !== 'string') {
          throw new TypeError('Expected a string');
        }
        parser.write(chunk);
        callback();
      },
      final(callback) {
        parser.end();
        callback();
      },
    });
  }
  options ??= {};
  options.treeAdapter ??= htmlparser2Adapter;
  if (options.scriptingEnabled !== false) {
    options.scriptingEnabled = true;
  }
  const stream = new Parse5Stream(options);
  finished(stream, (err) => cb(err, load(stream.document, options)));
  return stream;
}
/**
 * Creates a stream that parses a sequence of strings into a document.
 *
 * The stream is a `Writable` stream that accepts strings. When the stream is
 * finished, the callback is called with the loaded document.
 *
 * @category Loading
 * @example
 *
 * ```js
 * import * as cheerio from 'cheerio';
 * import * as fs from 'fs';
 *
 * const writeStream = cheerio.stringStream({}, (err, $) => {
 *   if (err) {
 *     // Handle error
 *   }
 *
 *   console.log($('h1').text());
 *   // Output: Hello, world!
 * });
 *
 * fs.createReadStream('my-document.html', { encoding: 'utf8' }).pipe(
 *   writeStream,
 * );
 * ```
 *
 * @param options - The options to pass to Cheerio.
 * @param cb - The callback to call when the stream is finished.
 * @returns The writable stream.
 */
export function stringStream(
  options: CheerioOptions,
  cb: (err: Error | null | undefined, $: CheerioAPI) => void,
): Writable {
  return _stringStream(flattenOptions(options), cb);
}
export interface DecodeStreamOptions extends CheerioOptions {
  encoding?: SnifferOptions;
}
/**
 * Parses a stream of buffers into a document.
 *
 * The stream is a `Writable` stream that accepts buffers. When the stream is
 * finished, the callback is called with the loaded document.
 *
 * @category Loading
 * @param options - The options to pass to Cheerio.
 * @param cb - The callback to call when the stream is finished.
 * @returns The writable stream.
 */
export function decodeStream(
  options: DecodeStreamOptions,
  cb: (err: Error | null | undefined, $: CheerioAPI) => void,
): Writable {
  const { encoding = {}, ...cheerioOptions } = options;
  const opts = flattenOptions(cheerioOptions);
  // Set the default encoding to UTF-8 for XML mode
  encoding.defaultEncoding ??= opts?.xmlMode ? 'utf8' : 'windows-1252';
  const decodeStream = new DecodeStream(encoding);
  const loadStream = _stringStream(opts, cb);
  decodeStream.pipe(loadStream);
  return decodeStream;
}
type UndiciStreamOptions = Omit<
  undici.Dispatcher.RequestOptions<unknown>,
  'path'
>;
export interface CheerioRequestOptions extends DecodeStreamOptions {
  /** The options passed to `undici`'s `stream` method. */
  requestOptions?: UndiciStreamOptions;
}
const defaultRequestOptions: UndiciStreamOptions = {
  method: 'GET',
  // Set an Accept header
  headers: {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  },
};
/**
 * `fromURL` loads a document from a URL.
 *
 * By default, redirects are allowed and non-2xx responses are rejected.
 *
 * @category Loading
 * @example
 *
 * ```js
 * import * as cheerio from 'cheerio';
 *
 * const $ = await cheerio.fromURL('https://example.com');
 * ```
 *
 * @param url - The URL to load the document from.
 * @param options - The options to pass to Cheerio.
 * @returns The loaded document.
 */
export async function fromURL(
  url: string | URL,
  options: CheerioRequestOptions = {},
): Promise<CheerioAPI> {
  const {
    requestOptions = defaultRequestOptions,
    encoding = {},
    ...cheerioOptions
  } = options;
  let undiciStream: Promise<undici.Dispatcher.StreamData<unknown>> | undefined;
  // Add headers if none were supplied.
  const urlObject = typeof url === 'string' ? new URL(url) : url;
  const streamOptions = {
    headers: defaultRequestOptions.headers,
    path: urlObject.pathname + urlObject.search,
    ...requestOptions,
  };
  const promise = new Promise<CheerioAPI>((resolve, reject) => {
    undiciStream = new undici.Client(urlObject.origin)
      .compose(undici.interceptors.redirect({ maxRedirections: 5 }))
      .stream(streamOptions, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          throw new undici.errors.ResponseError(
            'Response Error',
            res.statusCode,
            {
              headers: res.headers,
            },
          );
        }
        const contentTypeHeader = res.headers['content-type'] ?? 'text/html';
        const mimeType = new MIMEType(
          Array.isArray(contentTypeHeader)
            ? contentTypeHeader[0]
            : contentTypeHeader,
        );
        if (!mimeType.isHTML() && !mimeType.isXML()) {
          throw new RangeError(
            `The content-type "${mimeType.essence}" is neither HTML nor XML.`,
          );
        }
        // Forward the charset from the header to the decodeStream.
        encoding.transportLayerEncodingLabel =
          mimeType.parameters.get('charset');
        /*
         * If we allow redirects, we will have entries in the history.
         * The last entry will be the final URL.
         */
        const history = (
          res.context as
            | {
                history?: URL[];
              }
            | undefined
        )?.history;
        // Set the `baseURI` to the final URL.
        const baseURI = history ? history[history.length - 1] : urlObject;
        const opts: DecodeStreamOptions = {
          encoding,
          // Set XML mode based on the MIME type.
          xmlMode: mimeType.isXML(),
          baseURI,
          ...cheerioOptions,
        };
        return decodeStream(opts, (err, $) => (err ? reject(err) : resolve($)));
      });
  });
  // Let's make sure the request is completed before returning the promise.
  await undiciStream;
  return promise;
}
```
### `spine/acquisition/scrapers/node_modules/typesense/src/Typesense/Errors/index.ts`
```typescript
import HTTPError from "./HTTPError";
import MissingConfigurationError from "./MissingConfigurationError";
import ObjectAlreadyExists from "./ObjectAlreadyExists";
import ObjectNotFound from "./ObjectNotFound";
import ObjectUnprocessable from "./ObjectUnprocessable";
import RequestMalformed from "./RequestMalformed";
import RequestUnauthorized from "./RequestUnauthorized";
import ServerError from "./ServerError";
import ImportError from "./ImportError";
import TypesenseError from "./TypesenseError";
export {
  HTTPError,
  MissingConfigurationError,
  ObjectAlreadyExists,
  ObjectNotFound,
  ObjectUnprocessable,
  RequestMalformed,
  RequestUnauthorized,
  ServerError,
  TypesenseError,
  ImportError,
};
```
### `spine/acquisition/scrapers/node_modules/zod/src/index.ts`
```typescript
import * as z from "./v4/classic/external.js";
export * from "./v4/classic/external.js";
export { z };
export default z;
```
### `spine/acquisition/scrapers/node_modules/zod/src/locales/index.ts`
```typescript
export * from "../v4/locales/index.js";
```
### `spine/acquisition/scrapers/node_modules/zod/src/mini/index.ts`
```typescript
import * as z from "../v4/mini/external.js";
export * from "../v4/mini/external.js";
export { z };
```
### `spine/acquisition/scrapers/node_modules/zod/src/v3/benchmarks/index.ts`
```typescript
import type Benchmark from "benchmark";
import datetimeBenchmarks from "./datetime.js";
import discriminatedUnionBenchmarks from "./discriminatedUnion.js";
import ipv4Benchmarks from "./ipv4.js";
import objectBenchmarks from "./object.js";
import primitiveBenchmarks from "./primitives.js";
import realworld from "./realworld.js";
import stringBenchmarks from "./string.js";
import unionBenchmarks from "./union.js";
const argv = process.argv.slice(2);
let suites: Benchmark.Suite[] = [];
if (!argv.length) {
  suites = [
    ...realworld.suites,
    ...primitiveBenchmarks.suites,
    ...stringBenchmarks.suites,
    ...objectBenchmarks.suites,
    ...unionBenchmarks.suites,
    ...discriminatedUnionBenchmarks.suites,
  ];
} else {
  if (argv.includes("--realworld")) {
    suites.push(...realworld.suites);
  }
  if (argv.includes("--primitives")) {
    suites.push(...primitiveBenchmarks.suites);
  }
  if (argv.includes("--string")) {
    suites.push(...stringBenchmarks.suites);
  }
  if (argv.includes("--object")) {
    suites.push(...objectBenchmarks.suites);
  }
  if (argv.includes("--union")) {
    suites.push(...unionBenchmarks.suites);
  }
  if (argv.includes("--discriminatedUnion")) {
    suites.push(...datetimeBenchmarks.suites);
  }
  if (argv.includes("--datetime")) {
    suites.push(...datetimeBenchmarks.suites);
  }
  if (argv.includes("--ipv4")) {
    suites.push(...ipv4Benchmarks.suites);
  }
}
for (const suite of suites) {
  suite.run({});
}
// exit on Ctrl-C
process.on("SIGINT", function () {
  console.log("Exiting...");
  process.exit();
});
```
### `spine/acquisition/scrapers/node_modules/zod/src/v3/index.ts`
```typescript
import * as z from "./external.js";
export * from "./external.js";
export { z };
export default z;
```
### `spine/acquisition/scrapers/node_modules/zod/src/v4/classic/index.ts`
```typescript
import * as z from "./external.js";
export { z };
export * from "./external.js";
export default z;
```
### `spine/acquisition/scrapers/node_modules/zod/src/v4/core/index.ts`
```typescript
export * from "./core.js";
export * from "./parse.js";
export * from "./errors.js";
export * from "./schemas.js";
export * from "./checks.js";
export * from "./versions.js";
export * as util from "./util.js";
export * as regexes from "./regexes.js";
export * as locales from "../locales/index.js";
export * from "./registries.js";
export * from "./doc.js";
export * from "./api.js";
export * from "./to-json-schema.js";
export { toJSONSchema } from "./json-schema-processors.js";
export { JSONSchemaGenerator } from "./json-schema-generator.js";
export * as JSONSchema from "./json-schema.js";
```
### `spine/acquisition/scrapers/node_modules/zod/src/v4/index.ts`
```typescript
import z4 from "./classic/index.js";
export * from "./classic/index.js";
export default z4;
```
### `spine/acquisition/scrapers/node_modules/zod/src/v4/locales/index.ts`
```typescript
export { default as ar } from "./ar.js";
export { default as az } from "./az.js";
export { default as be } from "./be.js";
export { default as bg } from "./bg.js";
export { default as ca } from "./ca.js";
export { default as cs } from "./cs.js";
export { default as da } from "./da.js";
export { default as de } from "./de.js";
export { default as el } from "./el.js";
export { default as en } from "./en.js";
export { default as eo } from "./eo.js";
export { default as es } from "./es.js";
export { default as fa } from "./fa.js";
export { default as fi } from "./fi.js";
export { default as fr } from "./fr.js";
export { default as frCA } from "./fr-CA.js";
export { default as he } from "./he.js";
export { default as hr } from "./hr.js";
export { default as hu } from "./hu.js";
export { default as hy } from "./hy.js";
export { default as id } from "./id.js";
export { default as is } from "./is.js";
export { default as it } from "./it.js";
export { default as ja } from "./ja.js";
export { default as ka } from "./ka.js";
export { default as kh } from "./kh.js";
export { default as km } from "./km.js";
export { default as ko } from "./ko.js";
export { default as lt } from "./lt.js";
export { default as mk } from "./mk.js";
export { default as ms } from "./ms.js";
export { default as nl } from "./nl.js";
export { default as no } from "./no.js";
export { default as ota } from "./ota.js";
export { default as ps } from "./ps.js";
export { default as pl } from "./pl.js";
export { default as pt } from "./pt.js";
export { default as ro } from "./ro.js";
export { default as ru } from "./ru.js";
export { default as sl } from "./sl.js";
export { default as sv } from "./sv.js";
export { default as ta } from "./ta.js";
export { default as th } from "./th.js";
export { default as tr } from "./tr.js";
export { default as ua } from "./ua.js";
export { default as uk } from "./uk.js";
export { default as ur } from "./ur.js";
export { default as uz } from "./uz.js";
export { default as vi } from "./vi.js";
export { default as zhCN } from "./zh-CN.js";
export { default as zhTW } from "./zh-TW.js";
export { default as yo } from "./yo.js";
```
### `spine/acquisition/scrapers/node_modules/zod/src/v4/mini/index.ts`
```typescript
import * as z from "./external.js";
export * from "./external.js";
export { z };
```
### `spine/acquisition/scrapers/node_modules/zod/src/v4-mini/index.ts`
```typescript
import * as z from "../v4/mini/external.js";
export * from "../v4/mini/external.js";
export { z };
```
### `spine/acquisition/scrapers/scrapers/autoline/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { runDetailPhase } from './scraper.js';
import { runSitemapPhase } from './sitemap.js';
import type { ScraperConfig } from './types.js';
// Filter out bare '--' injected by pnpm so parseArgs treats flags correctly
const args = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '5' },
    delay: { type: 'string', default: '1000' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
  },
});
const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '5'), 10),
  delay: parseInt(String(values.delay ?? '1000'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};
console.log('Autoline.cz Scraper');
console.log(`Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`);
console.log(`DB: ${config.dbPath}`);
console.log('');
const shutdown = createShutdownHandler();
shutdown.setup();
const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});
const run = async () => {
  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }
    if (config.phase === 'all' || config.phase === 'detail') {
      // Pause before detail phase to let any residual rate limiting expire
      if (config.phase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (!shutdown.isShuttingDown()) {
      db.close();
    }
  }
};
run();
```
### `spine/acquisition/scrapers/scrapers/esbirka/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { runDiscoveryPhase } from './discovery.js';
import { runDetailPhase } from './scraper.js';
import type { ScraperConfig } from './types.js';
const args = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    collection: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '5' },
    delay: { type: 'string', default: '200' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
  },
});
const collectionArg = String(values.collection || 'all');
if (!['sb', 'sm', 'all'].includes(collectionArg)) {
  console.error('Invalid --collection. Use: sb, sm, or all');
  process.exit(1);
}
const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  collection: collectionArg as ScraperConfig['collection'],
  concurrency: parseInt(String(values.concurrency ?? '5'), 10),
  delay: parseInt(String(values.delay ?? '200'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};
console.log('e-Sbírka Scraper (Czech Legislation)');
console.log(
  `Phase: ${config.phase}, Collection: ${config.collection}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`,
);
console.log(`DB: ${config.dbPath}`);
console.log('');
const shutdown = createShutdownHandler();
shutdown.setup();
const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});
const run = async () => {
  try {
    if (config.phase === 'all' || config.phase === 'discovery') {
      await runDiscoveryPhase(db, config, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }
    if (config.phase === 'all' || config.phase === 'detail') {
      if (config.phase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (!shutdown.isShuttingDown()) {
      db.close();
    }
  }
};
run();
```
### `spine/acquisition/scrapers/scrapers/firmy-cz/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { runDetailPhase } from './scraper.js';
import { runSitemapPhase } from './sitemap.js';
import type { ScraperConfig } from './types.js';
const args = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '3' },
    delay: { type: 'string', default: '2000' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
  },
});
const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '3'), 10),
  delay: parseInt(String(values.delay ?? '2000'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};
console.log('Firmy.cz Scraper');
console.log(`Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`);
console.log(`DB: ${config.dbPath}`);
console.log('');
const shutdown = createShutdownHandler();
shutdown.setup();
const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});
const run = async () => {
  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }
    if (config.phase === 'all' || config.phase === 'detail') {
      if (config.phase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (!shutdown.isShuttingDown()) {
      db.close();
    }
  }
};
run();
```
### `spine/acquisition/scrapers/scrapers/judikaty/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { setupLogging } from './logger.js';
import type { ScraperConfig, Source, SourceModule } from './types.js';
const args = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args,
  strict: false,
  options: {
    source: { type: 'string', default: '' },
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '5' },
    delay: { type: 'string', default: '100' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
    'log-file': { type: 'string', default: '' },
  },
});
const sourceArg = String(values.source || '');
if (!sourceArg || !['justice', 'usoud', 'nssoud', 'nsoud', 'all'].includes(sourceArg)) {
  console.error('Usage: scrape:judikaty -- --source=<justice|usoud|nssoud|nsoud|all> [--phase=all] [options]');
  process.exit(1);
}
const config: ScraperConfig = {
  source: sourceArg as ScraperConfig['source'],
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '5'), 10),
  delay: parseInt(String(values.delay ?? '500'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};
// vyhledavac.nssoud.cz has no robots.txt (nssoud.cz has Crawl-delay: 10 but that's the TYPO3 site, not the search app)
const logFile = String(values['log-file'] || '') || undefined;
setupLogging(logFile);
console.log('Czech Court Decisions Scraper (Judikáty)');
console.log(
  `Source: ${config.source}, Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`,
);
console.log(`DB: ${config.dbPath}`);
console.log('');
const shutdown = createShutdownHandler();
shutdown.setup();
const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});
const loadSource = async (source: Source): Promise<SourceModule> => {
  switch (source) {
    case 'justice': {
      const discovery = await import('./sources/justice/discovery.js');
      const scraper = await import('./sources/justice/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'usoud': {
      const discovery = await import('./sources/usoud/discovery.js');
      const scraper = await import('./sources/usoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'nssoud': {
      const discovery = await import('./sources/nssoud/discovery.js');
      const scraper = await import('./sources/nssoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
    case 'nsoud': {
      const discovery = await import('./sources/nsoud/discovery.js');
      const scraper = await import('./sources/nsoud/scraper.js');
      return { runDiscovery: discovery.runDiscovery, runDetail: scraper.runDetail };
    }
  }
};
const runSource = async (source: Source) => {
  if (shutdown.isShuttingDown()) return;
  const sourceConfig: ScraperConfig = { ...config, source };
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Source: ${source}`);
  console.log('='.repeat(60));
  const mod = await loadSource(source);
  if (config.phase === 'all' || config.phase === 'discovery') {
    await mod.runDiscovery(db, sourceConfig, shutdown.isShuttingDown);
    if (shutdown.isShuttingDown()) return;
  }
  if (config.phase === 'all' || config.phase === 'detail') {
    if (config.phase === 'all') {
      console.log('Waiting 5s before detail phase...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    await mod.runDetail(db, sourceConfig, shutdown.isShuttingDown);
  }
};
const ALL_SOURCES: Source[] = ['justice', 'usoud', 'nssoud', 'nsoud'];
const run = async () => {
  try {
    const sources = config.source === 'all' ? ALL_SOURCES : [config.source as Source];
    for (const source of sources) {
      if (shutdown.isShuttingDown()) break;
      await runSource(source);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (!shutdown.isShuttingDown()) {
      db.close();
    }
  }
};
run();
```
### `spine/acquisition/scrapers/scrapers/mascus-cz/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { createDb } from './db.js';
import { runDetailPhase } from './scraper.js';
import { runSitemapPhase } from './sitemap.js';
import type { ScraperConfig } from './types.js';
// Filter out bare '--' injected by pnpm so parseArgs treats flags correctly
const args = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '5' },
    delay: { type: 'string', default: '1000' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    db: { type: 'string', default: '' },
  },
});
const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '5'), 10),
  delay: parseInt(String(values.delay ?? '1000'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};
console.log('Mascus.cz Scraper');
console.log(`Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`);
console.log(`DB: ${config.dbPath}`);
console.log('');
const shutdown = createShutdownHandler();
shutdown.setup();
const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});
const run = async () => {
  try {
    if (config.phase === 'all' || config.phase === 'sitemap') {
      await runSitemapPhase(db, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }
    if (config.phase === 'all' || config.phase === 'detail') {
      // Pause before detail phase to let any residual rate limiting expire
      if (config.phase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (!shutdown.isShuttingDown()) {
      db.close();
    }
  }
};
run();
```
### `spine/acquisition/scrapers/scrapers/mobile-de/index.ts`
```typescript
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createShutdownHandler } from '../../lib/utils.js';
import { closeBrowser, createBrowserContext, launchBrowser } from './browser.js';
import { createDb } from './db.js';
import { runDetailPhase } from './scraper.js';
import { runSearchPhase } from './search.js';
import type { ScraperConfig, VehicleCategory } from './types.js';
const ALL_CATEGORIES: VehicleCategory[] = ['Car', 'Motorbike', 'Truck', 'MotorHome'];
// Filter out bare '--' injected by pnpm so parseArgs treats flags correctly
const args = process.argv.slice(2).filter((a) => a !== '--');
const { values } = parseArgs({
  args,
  strict: false,
  options: {
    phase: { type: 'string', default: 'all' },
    concurrency: { type: 'string', default: '2' },
    delay: { type: 'string', default: '3000' },
    'max-retries': { type: 'string', default: '3' },
    limit: { type: 'string', default: '0' },
    categories: { type: 'string', default: '' },
    headless: { type: 'string', default: 'true' },
    db: { type: 'string', default: '' },
    'reset-search': { type: 'boolean', default: false },
  },
});
const parseCategories = (input: string): VehicleCategory[] => {
  if (!input) return ALL_CATEGORIES;
  return input
    .split(',')
    .map((c) => c.trim())
    .filter((c) => ALL_CATEGORIES.includes(c as VehicleCategory)) as VehicleCategory[];
};
const config: ScraperConfig = {
  phase: (values.phase as ScraperConfig['phase']) ?? 'all',
  concurrency: parseInt(String(values.concurrency ?? '2'), 10),
  delay: parseInt(String(values.delay ?? '3000'), 10),
  maxRetries: parseInt(String(values['max-retries'] ?? '3'), 10),
  limit: parseInt(String(values.limit ?? '0'), 10),
  categories: parseCategories(String(values.categories ?? '')),
  headless: values.headless !== 'false',
  dbPath: String(values.db || '') || resolve('data', 'garaaage.db'),
};
console.log('mobile.de/cz Scraper');
console.log(`Phase: ${config.phase}, Concurrency: ${config.concurrency}, Delay: ${config.delay}ms`);
console.log(`Categories: ${config.categories.join(', ')}`);
console.log(`Headless: ${config.headless}`);
console.log(`DB: ${config.dbPath}`);
console.log('');
const shutdown = createShutdownHandler();
shutdown.setup();
const db = createDb(config.dbPath);
shutdown.onShutdown(() => {
  console.log('Closing database...');
  db.close();
});
if (values['reset-search']) {
  console.log('Resetting search segments and progress...');
  db.resetSearch();
  console.log('Search data cleared.\n');
}
const run = async () => {
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null;
  try {
    browser = await launchBrowser(config.headless);
    shutdown.onShutdown(async () => {
      console.log('Closing browser...');
      await closeBrowser(browser);
    });
    const context = await createBrowserContext(browser);
    if (config.phase === 'all' || config.phase === 'search') {
      await runSearchPhase(context, db, config, shutdown.isShuttingDown);
      if (shutdown.isShuttingDown()) return;
    }
    if (config.phase === 'all' || config.phase === 'detail') {
      // Pause before detail phase if running both phases
      if (config.phase === 'all') {
        console.log('Waiting 5s before detail phase...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await runDetailPhase(context, db, config, shutdown.isShuttingDown);
    }
  } catch (error) {
    console.error('Fatal error:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    if (!shutdown.isShuttingDown()) {
      await closeBrowser(browser);
      db.close();
    }
  }
};
run();
```
### `spine/acquisition/scrapers/src/index.ts`
```typescript
import 'dotenv/config';
import type { Server } from 'http';
import { logger } from '../lib/logger.js';
import { startWorker, stopWorker } from './queue/scrape-worker.js';
import { startHealthServer } from '../lib/health.js';
const worker = startWorker();
// Spustit health server (default port 8090 dle konvence)
const healthPort = parseInt(process.env.HEALTH_PORT || '8090', 10);
const healthServer: Server = startHealthServer(healthPort, 'scrapers');
const shutdown = async () => {
  logger.info('scrape-worker: received shutdown signal');
  // Zavřít health server
  await new Promise<void>((resolve) => {
    healthServer.close(() => {
      resolve();
    });
  });
  await stopWorker();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
logger.info({ pid: process.pid, healthPort }, 'garaaage-scrapers worker running');
// Keep the process alive — BullMQ worker maintains its own event loop.
export { worker, healthServer };
```
### `spine/demand/acquisition/deep-inventory/index.ts`
```typescript
export * from './scraper';
export * from './queue';
export * from './worker';
export * from './scheduler';
export * from './delta-engine';
```
### `spine/engine/automation/symphony-queue/index.ts`
```typescript
export { SymphonyQueue } from './logic';
export type { ArbitrageOpportunity } from '../../../domain/core-types/index';
```
### `spine/engine/intelligence/relay/index.ts`
```typescript
export * from './logic';
```
### `spine/engine/learn/index.ts`
```typescript
export * from './self-healing';
```
### `spine/platform/mcp/mcp-server/index.ts`
```typescript
import './sentry.js';
import { parseArgs } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, registerResources, initSources } from './tools.js';
import { VERSION } from './version.js';
import { logger } from '../lib/logger.js';
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    mode: { type: 'string', default: 'stdio' },
  },
  strict: false,
});
if (values.mode === 'http') {
  const port = parseInt(process.env.MCP_PORT || '3000', 10);
  const issuerUrl = process.env.MCP_ISSUER_URL;
  const secret = process.env.MCP_SECRET;
  if (!issuerUrl || !secret) {
    logger.fatal('HTTP mode requires MCP_ISSUER_URL and MCP_SECRET environment variables');
    process.exit(1);
  }
  const { startHttpServer } = await import('./http.js');
  const { createRedisStore, createMemoryStore } = await import('./auth.js');
  let store;
  if (process.env.REDIS_URL) {
    const ioredis = await import('ioredis');
    const RedisClient = ioredis.default ?? ioredis;
    const redis = new (RedisClient as any)(process.env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    redis.on('error', (err: unknown) => logger.warn({ err }, 'Redis client error'));
    try {
      await redis.connect();
      store = createRedisStore(redis);
      logger.info('OAuth store: Redis');
    } catch (e) {
      logger.warn({ err: e }, 'Redis connection failed, falling back to in-memory');
      store = createMemoryStore();
    }
  } else {
    store = createMemoryStore();
    logger.info('OAuth store: in-memory (set REDIS_URL for persistence)');
  }
  const sourceNames = await initSources();
  logger.info({ sources: sourceNames }, 'Sources discovered');
  startHttpServer(port, issuerUrl, secret, store);
} else {
  const sourceNames = await initSources();
  logger.info({ sources: sourceNames }, 'Sources discovered');
  const server = new McpServer({
    name: 'garaaage-scrapers',
    version: VERSION,
  });
  registerTools(server);
  registerResources(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```
### `spine/platform/mcp/node_modules/typesense/src/Typesense/Errors/index.ts`
```typescript
import HTTPError from "./HTTPError";
import MissingConfigurationError from "./MissingConfigurationError";
import ObjectAlreadyExists from "./ObjectAlreadyExists";
import ObjectNotFound from "./ObjectNotFound";
import ObjectUnprocessable from "./ObjectUnprocessable";
import RequestMalformed from "./RequestMalformed";
import RequestUnauthorized from "./RequestUnauthorized";
import ServerError from "./ServerError";
import ImportError from "./ImportError";
import TypesenseError from "./TypesenseError";
export {
  HTTPError,
  MissingConfigurationError,
  ObjectAlreadyExists,
  ObjectNotFound,
  ObjectUnprocessable,
  RequestMalformed,
  RequestUnauthorized,
  ServerError,
  TypesenseError,
  ImportError,
};
```
### `spine/platform/mcp/node_modules/zod/src/index.ts`
```typescript
import * as z from "./v4/classic/external.js";
export * from "./v4/classic/external.js";
export { z };
export default z;
```
### `spine/platform/mcp/node_modules/zod/src/locales/index.ts`
```typescript
export * from "../v4/locales/index.js";
```
### `spine/platform/mcp/node_modules/zod/src/mini/index.ts`
```typescript
import * as z from "../v4/mini/external.js";
export * from "../v4/mini/external.js";
export { z };
```
### `spine/platform/mcp/node_modules/zod/src/v3/benchmarks/index.ts`
```typescript
import type Benchmark from "benchmark";
import datetimeBenchmarks from "./datetime.js";
import discriminatedUnionBenchmarks from "./discriminatedUnion.js";
import ipv4Benchmarks from "./ipv4.js";
import objectBenchmarks from "./object.js";
import primitiveBenchmarks from "./primitives.js";
import realworld from "./realworld.js";
import stringBenchmarks from "./string.js";
import unionBenchmarks from "./union.js";
const argv = process.argv.slice(2);
let suites: Benchmark.Suite[] = [];
if (!argv.length) {
  suites = [
    ...realworld.suites,
    ...primitiveBenchmarks.suites,
    ...stringBenchmarks.suites,
    ...objectBenchmarks.suites,
    ...unionBenchmarks.suites,
    ...discriminatedUnionBenchmarks.suites,
  ];
} else {
  if (argv.includes("--realworld")) {
    suites.push(...realworld.suites);
  }
  if (argv.includes("--primitives")) {
    suites.push(...primitiveBenchmarks.suites);
  }
  if (argv.includes("--string")) {
    suites.push(...stringBenchmarks.suites);
  }
  if (argv.includes("--object")) {
    suites.push(...objectBenchmarks.suites);
  }
  if (argv.includes("--union")) {
    suites.push(...unionBenchmarks.suites);
  }
  if (argv.includes("--discriminatedUnion")) {
    suites.push(...datetimeBenchmarks.suites);
  }
  if (argv.includes("--datetime")) {
    suites.push(...datetimeBenchmarks.suites);
  }
  if (argv.includes("--ipv4")) {
    suites.push(...ipv4Benchmarks.suites);
  }
}
for (const suite of suites) {
  suite.run({});
}
// exit on Ctrl-C
process.on("SIGINT", function () {
  console.log("Exiting...");
  process.exit();
});
```
### `spine/platform/mcp/node_modules/zod/src/v3/index.ts`
```typescript
import * as z from "./external.js";
export * from "./external.js";
export { z };
export default z;
```
### `spine/platform/mcp/node_modules/zod/src/v4/classic/index.ts`
```typescript
import * as z from "./external.js";
export { z };
export * from "./external.js";
export default z;
```
### `spine/platform/mcp/node_modules/zod/src/v4/core/index.ts`
```typescript
export * from "./core.js";
export * from "./parse.js";
export * from "./errors.js";
export * from "./schemas.js";
export * from "./checks.js";
export * from "./versions.js";
export * as util from "./util.js";
export * as regexes from "./regexes.js";
export * as locales from "../locales/index.js";
export * from "./registries.js";
export * from "./doc.js";
export * from "./api.js";
export * from "./to-json-schema.js";
export { toJSONSchema } from "./json-schema-processors.js";
export { JSONSchemaGenerator } from "./json-schema-generator.js";
export * as JSONSchema from "./json-schema.js";
```
### `spine/platform/mcp/node_modules/zod/src/v4/index.ts`
```typescript
import z4 from "./classic/index.js";
export * from "./classic/index.js";
export default z4;
```
### `spine/platform/mcp/node_modules/zod/src/v4/locales/index.ts`
```typescript
export { default as ar } from "./ar.js";
export { default as az } from "./az.js";
export { default as be } from "./be.js";
export { default as bg } from "./bg.js";
export { default as ca } from "./ca.js";
export { default as cs } from "./cs.js";
export { default as da } from "./da.js";
export { default as de } from "./de.js";
export { default as el } from "./el.js";
export { default as en } from "./en.js";
export { default as eo } from "./eo.js";
export { default as es } from "./es.js";
export { default as fa } from "./fa.js";
export { default as fi } from "./fi.js";
export { default as fr } from "./fr.js";
export { default as frCA } from "./fr-CA.js";
export { default as he } from "./he.js";
export { default as hr } from "./hr.js";
export { default as hu } from "./hu.js";
export { default as hy } from "./hy.js";
export { default as id } from "./id.js";
export { default as is } from "./is.js";
export { default as it } from "./it.js";
export { default as ja } from "./ja.js";
export { default as ka } from "./ka.js";
export { default as kh } from "./kh.js";
export { default as km } from "./km.js";
export { default as ko } from "./ko.js";
export { default as lt } from "./lt.js";
export { default as mk } from "./mk.js";
export { default as ms } from "./ms.js";
export { default as nl } from "./nl.js";
export { default as no } from "./no.js";
export { default as ota } from "./ota.js";
export { default as ps } from "./ps.js";
export { default as pl } from "./pl.js";
export { default as pt } from "./pt.js";
export { default as ro } from "./ro.js";
export { default as ru } from "./ru.js";
export { default as sl } from "./sl.js";
export { default as sv } from "./sv.js";
export { default as ta } from "./ta.js";
export { default as th } from "./th.js";
export { default as tr } from "./tr.js";
export { default as ua } from "./ua.js";
export { default as uk } from "./uk.js";
export { default as ur } from "./ur.js";
export { default as uz } from "./uz.js";
export { default as vi } from "./vi.js";
export { default as zhCN } from "./zh-CN.js";
export { default as zhTW } from "./zh-TW.js";
export { default as yo } from "./yo.js";
```
### `spine/platform/mcp/node_modules/zod/src/v4/mini/index.ts`
```typescript
import * as z from "./external.js";
export * from "./external.js";
export { z };
```
### `spine/platform/mcp/node_modules/zod/src/v4-mini/index.ts`
```typescript
import * as z from "../v4/mini/external.js";
export * from "../v4/mini/external.js";
export { z };
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/helpers/index.ts`
```typescript
export { jsonSchemaOutputFormat } from './json-schema';
export { zodOutputFormat } from './zod';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export { Anthropic as default } from './client';
export { type Uploadable, toFile } from './core/uploads';
export { APIPromise } from './core/api-promise';
export { BaseAnthropic, Anthropic, type ClientOptions, HUMAN_PROMPT, AI_PROMPT } from './client';
export { PagePromise } from './core/pagination';
export {
  AnthropicError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  BadRequestError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  UnprocessableEntityError,
} from './core/error';
export type {
  AutoParseableOutputFormat,
  ParsedMessage,
  ParsedContentBlock,
  ParseableMessageCreateParams,
  ExtractParsedContentFromParams,
} from './lib/parser';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/internal/qs/index.ts`
```typescript
import { default_format, formatters, RFC1738, RFC3986 } from './formats';
const formats = {
  formatters,
  RFC1738,
  RFC3986,
  default: default_format,
};
export { stringify } from './stringify';
export { formats };
export type { DefaultDecoder, DefaultEncoder, Format, ParseOptions, StringifyOptions } from './types';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/agents/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Agents,
  type BetaManagedAgentsAgent,
  type BetaManagedAgentsAgentReference,
  type BetaManagedAgentsAgentToolConfig,
  type BetaManagedAgentsAgentToolConfigParams,
  type BetaManagedAgentsAgentToolsetDefaultConfig,
  type BetaManagedAgentsAgentToolsetDefaultConfigParams,
  type BetaManagedAgentsAgentToolset20260401,
  type BetaManagedAgentsAgentToolset20260401Params,
  type BetaManagedAgentsAlwaysAllowPolicy,
  type BetaManagedAgentsAlwaysAskPolicy,
  type BetaManagedAgentsAnthropicSkill,
  type BetaManagedAgentsAnthropicSkillParams,
  type BetaManagedAgentsCustomSkill,
  type BetaManagedAgentsCustomSkillParams,
  type BetaManagedAgentsCustomTool,
  type BetaManagedAgentsCustomToolInputSchema,
  type BetaManagedAgentsCustomToolParams,
  type BetaManagedAgentsMCPServerURLDefinition,
  type BetaManagedAgentsMCPToolConfig,
  type BetaManagedAgentsMCPToolConfigParams,
  type BetaManagedAgentsMCPToolset,
  type BetaManagedAgentsMCPToolsetDefaultConfig,
  type BetaManagedAgentsMCPToolsetDefaultConfigParams,
  type BetaManagedAgentsMCPToolsetParams,
  type BetaManagedAgentsModel,
  type BetaManagedAgentsModelConfig,
  type BetaManagedAgentsModelConfigParams,
  type BetaManagedAgentsMultiagentCoordinator,
  type BetaManagedAgentsMultiagentCoordinatorParams,
  type BetaManagedAgentsMultiagentSelfParams,
  type BetaManagedAgentsSkillParams,
  type BetaManagedAgentsURLMCPServerParams,
  type AgentCreateParams,
  type AgentRetrieveParams,
  type AgentUpdateParams,
  type AgentListParams,
  type AgentArchiveParams,
  type BetaManagedAgentsAgentsPageCursor,
} from './agents';
export { Versions, type VersionListParams } from './versions';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Agents,
  type BetaManagedAgentsAgent,
  type BetaManagedAgentsAgentReference,
  type BetaManagedAgentsAgentToolConfig,
  type BetaManagedAgentsAgentToolConfigParams,
  type BetaManagedAgentsAgentToolsetDefaultConfig,
  type BetaManagedAgentsAgentToolsetDefaultConfigParams,
  type BetaManagedAgentsAgentToolset20260401,
  type BetaManagedAgentsAgentToolset20260401Params,
  type BetaManagedAgentsAlwaysAllowPolicy,
  type BetaManagedAgentsAlwaysAskPolicy,
  type BetaManagedAgentsAnthropicSkill,
  type BetaManagedAgentsAnthropicSkillParams,
  type BetaManagedAgentsCustomSkill,
  type BetaManagedAgentsCustomSkillParams,
  type BetaManagedAgentsCustomTool,
  type BetaManagedAgentsCustomToolInputSchema,
  type BetaManagedAgentsCustomToolParams,
  type BetaManagedAgentsMCPServerURLDefinition,
  type BetaManagedAgentsMCPToolConfig,
  type BetaManagedAgentsMCPToolConfigParams,
  type BetaManagedAgentsMCPToolset,
  type BetaManagedAgentsMCPToolsetDefaultConfig,
  type BetaManagedAgentsMCPToolsetDefaultConfigParams,
  type BetaManagedAgentsMCPToolsetParams,
  type BetaManagedAgentsModel,
  type BetaManagedAgentsModelConfig,
  type BetaManagedAgentsModelConfigParams,
  type BetaManagedAgentsMultiagentCoordinator,
  type BetaManagedAgentsMultiagentCoordinatorParams,
  type BetaManagedAgentsMultiagentSelfParams,
  type BetaManagedAgentsSkillParams,
  type BetaManagedAgentsURLMCPServerParams,
  type AgentCreateParams,
  type AgentRetrieveParams,
  type AgentUpdateParams,
  type AgentListParams,
  type AgentArchiveParams,
  type BetaManagedAgentsAgentsPageCursor,
} from './agents/index';
export {
  Beta,
  type AnthropicBeta,
  type BetaAPIError,
  type BetaAuthenticationError,
  type BetaBillingError,
  type BetaError,
  type BetaErrorResponse,
  type BetaGatewayTimeoutError,
  type BetaInvalidRequestError,
  type BetaNotFoundError,
  type BetaOverloadedError,
  type BetaPermissionError,
  type BetaRateLimitError,
} from './beta';
export {
  Environments,
  type BetaCloudConfig,
  type BetaCloudConfigParams,
  type BetaEnvironment,
  type BetaEnvironmentDeleteResponse,
  type BetaLimitedNetwork,
  type BetaLimitedNetworkParams,
  type BetaPackages,
  type BetaPackagesParams,
  type BetaUnrestrictedNetwork,
  type EnvironmentCreateParams,
  type EnvironmentRetrieveParams,
  type EnvironmentUpdateParams,
  type EnvironmentListParams,
  type EnvironmentDeleteParams,
  type EnvironmentArchiveParams,
  type BetaEnvironmentsPageCursor,
} from './environments';
export {
  Files,
  type BetaFileScope,
  type DeletedFile,
  type FileMetadata,
  type FileListParams,
  type FileDeleteParams,
  type FileDownloadParams,
  type FileRetrieveMetadataParams,
  type FileUploadParams,
  type FileMetadataPage,
} from './files';
export {
  MemoryStores,
  type BetaManagedAgentsDeletedMemoryStore,
  type BetaManagedAgentsMemoryStore,
  type MemoryStoreCreateParams,
  type MemoryStoreRetrieveParams,
  type MemoryStoreUpdateParams,
  type MemoryStoreListParams,
  type MemoryStoreDeleteParams,
  type MemoryStoreArchiveParams,
  type BetaManagedAgentsMemoryStoresPageCursor,
} from './memory-stores/index';
export {
  Messages,
  type BetaAdvisorMessageIterationUsage,
  type BetaAdvisorRedactedResultBlock,
  type BetaAdvisorRedactedResultBlockParam,
  type BetaAdvisorResultBlock,
  type BetaAdvisorResultBlockParam,
  type BetaAdvisorTool20260301,
  type BetaAdvisorToolResultBlock,
  type BetaAdvisorToolResultBlockParam,
  type BetaAdvisorToolResultError,
  type BetaAdvisorToolResultErrorParam,
  type BetaAllThinkingTurns,
  type BetaBase64ImageSource,
  type BetaBase64PDFSource,
  type BetaBashCodeExecutionOutputBlock,
  type BetaBashCodeExecutionOutputBlockParam,
  type BetaBashCodeExecutionResultBlock,
  type BetaBashCodeExecutionResultBlockParam,
  type BetaBashCodeExecutionToolResultBlock,
  type BetaBashCodeExecutionToolResultBlockParam,
  type BetaBashCodeExecutionToolResultError,
  type BetaBashCodeExecutionToolResultErrorParam,
  type BetaCacheControlEphemeral,
  type BetaCacheCreation,
  type BetaCitationCharLocation,
  type BetaCitationCharLocationParam,
  type BetaCitationConfig,
  type BetaCitationContentBlockLocation,
  type BetaCitationContentBlockLocationParam,
  type BetaCitationPageLocation,
  type BetaCitationPageLocationParam,
  type BetaCitationSearchResultLocation,
  type BetaCitationSearchResultLocationParam,
  type BetaCitationWebSearchResultLocationParam,
  type BetaCitationsConfigParam,
  type BetaCitationsDelta,
  type BetaCitationsWebSearchResultLocation,
  type BetaClearThinking20251015Edit,
  type BetaClearThinking20251015EditResponse,
  type BetaClearToolUses20250919Edit,
  type BetaClearToolUses20250919EditResponse,
  type BetaCodeExecutionOutputBlock,
  type BetaCodeExecutionOutputBlockParam,
  type BetaCodeExecutionResultBlock,
  type BetaCodeExecutionResultBlockParam,
  type BetaCodeExecutionTool20250522,
  type BetaCodeExecutionTool20250825,
  type BetaCodeExecutionTool20260120,
  type BetaCodeExecutionToolResultBlock,
  type BetaCodeExecutionToolResultBlockContent,
  type BetaCodeExecutionToolResultBlockParam,
  type BetaCodeExecutionToolResultBlockParamContent,
  type BetaCodeExecutionToolResultError,
  type BetaCodeExecutionToolResultErrorCode,
  type BetaCodeExecutionToolResultErrorParam,
  type BetaCompact20260112Edit,
  type BetaCompactionBlock,
  type BetaCompactionBlockParam,
  type BetaCompactionContentBlockDelta,
  type BetaCompactionIterationUsage,
  type BetaContainer,
  type BetaContainerParams,
  type BetaContainerUploadBlock,
  type BetaContainerUploadBlockParam,
  type BetaContentBlock,
  type BetaContentBlockParam,
  type BetaContentBlockSource,
  type BetaContentBlockSourceContent,
  type BetaContextManagementConfig,
  type BetaContextManagementResponse,
  type BetaCountTokensContextManagementResponse,
  type BetaDirectCaller,
  type BetaDocumentBlock,
  type BetaEncryptedCodeExecutionResultBlock,
  type BetaEncryptedCodeExecutionResultBlockParam,
  type BetaFileDocumentSource,
  type BetaFileImageSource,
  type BetaImageBlockParam,
  type BetaInputJSONDelta,
  type BetaInputTokensClearAtLeast,
  type BetaInputTokensTrigger,
  type BetaIterationsUsage,
  type BetaJSONOutputFormat,
  type BetaMCPToolConfig,
  type BetaMCPToolDefaultConfig,
  type BetaMCPToolResultBlock,
  type BetaMCPToolUseBlock,
  type BetaMCPToolUseBlockParam,
  type BetaMCPToolset,
  type BetaMemoryTool20250818,
  type BetaMemoryTool20250818Command,
  type BetaMemoryTool20250818CreateCommand,
  type BetaMemoryTool20250818DeleteCommand,
  type BetaMemoryTool20250818InsertCommand,
  type BetaMemoryTool20250818RenameCommand,
  type BetaMemoryTool20250818StrReplaceCommand,
  type BetaMemoryTool20250818ViewCommand,
  type BetaMessage,
  type BetaMessageDeltaUsage,
  type BetaMessageIterationUsage,
  type BetaMessageParam,
  type BetaMessageTokensCount,
  type BetaMetadata,
  type BetaOutputConfig,
  type BetaPlainTextSource,
  type BetaRawContentBlockDelta,
  type BetaRawContentBlockDeltaEvent,
  type BetaRawContentBlockStartEvent,
  type BetaRawContentBlockStopEvent,
  type BetaRawMessageDeltaEvent,
  type BetaRawMessageStartEvent,
  type BetaRawMessageStopEvent,
  type BetaRawMessageStreamEvent,
  type BetaRedactedThinkingBlock,
  type BetaRedactedThinkingBlockParam,
  type BetaRefusalStopDetails,
  type BetaRequestDocumentBlock,
  type BetaRequestMCPServerToolConfiguration,
  type BetaRequestMCPServerURLDefinition,
  type BetaRequestMCPToolResultBlockParam,
  type BetaSearchResultBlockParam,
  type BetaServerToolCaller,
  type BetaServerToolCaller20260120,
  type BetaServerToolUsage,
  type BetaServerToolUseBlock,
  type BetaServerToolUseBlockParam,
  type BetaSignatureDelta,
  type BetaSkill,
  type BetaSkillParams,
  type BetaStopReason,
  type BetaTextBlock,
  type BetaTextBlockParam,
  type BetaTextCitation,
  type BetaTextCitationParam,
  type BetaTextDelta,
  type BetaTextEditorCodeExecutionCreateResultBlock,
  type BetaTextEditorCodeExecutionCreateResultBlockParam,
  type BetaTextEditorCodeExecutionStrReplaceResultBlock,
  type BetaTextEditorCodeExecutionStrReplaceResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultBlock,
  type BetaTextEditorCodeExecutionToolResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultError,
  type BetaTextEditorCodeExecutionToolResultErrorParam,
  type BetaTextEditorCodeExecutionViewResultBlock,
  type BetaTextEditorCodeExecutionViewResultBlockParam,
  type BetaThinkingBlock,
  type BetaThinkingBlockParam,
  type BetaThinkingConfigAdaptive,
  type BetaThinkingConfigDisabled,
  type BetaThinkingConfigEnabled,
  type BetaThinkingConfigParam,
  type BetaThinkingDelta,
  type BetaThinkingTurns,
  type BetaTokenTaskBudget,
  type BetaTool,
  type BetaToolBash20241022,
  type BetaToolBash20250124,
  type BetaToolChoice,
  type BetaToolChoiceAny,
  type BetaToolChoiceAuto,
  type BetaToolChoiceNone,
  type BetaToolChoiceTool,
  type BetaToolComputerUse20241022,
  type BetaToolComputerUse20250124,
  type BetaToolComputerUse20251124,
  type BetaToolReferenceBlock,
  type BetaToolReferenceBlockParam,
  type BetaToolResultBlockParam,
  type BetaToolSearchToolBm25_20251119,
  type BetaToolSearchToolRegex20251119,
  type BetaToolSearchToolResultBlock,
  type BetaToolSearchToolResultBlockParam,
  type BetaToolSearchToolResultError,
  type BetaToolSearchToolResultErrorParam,
  type BetaToolSearchToolSearchResultBlock,
  type BetaToolSearchToolSearchResultBlockParam,
  type BetaToolTextEditor20241022,
  type BetaToolTextEditor20250124,
  type BetaToolTextEditor20250429,
  type BetaToolTextEditor20250728,
  type BetaToolUnion,
  type BetaToolUseBlock,
  type BetaToolUseBlockParam,
  type BetaToolUsesKeep,
  type BetaToolUsesTrigger,
  type BetaURLImageSource,
  type BetaURLPDFSource,
  type BetaUsage,
  type BetaUserLocation,
  type BetaWebFetchBlock,
  type BetaWebFetchBlockParam,
  type BetaWebFetchTool20250910,
  type BetaWebFetchTool20260209,
  type BetaWebFetchTool20260309,
  type BetaWebFetchToolResultBlock,
  type BetaWebFetchToolResultBlockParam,
  type BetaWebFetchToolResultErrorBlock,
  type BetaWebFetchToolResultErrorBlockParam,
  type BetaWebFetchToolResultErrorCode,
  type BetaWebSearchResultBlock,
  type BetaWebSearchResultBlockParam,
  type BetaWebSearchTool20250305,
  type BetaWebSearchTool20260209,
  type BetaWebSearchToolRequestError,
  type BetaWebSearchToolResultBlock,
  type BetaWebSearchToolResultBlockContent,
  type BetaWebSearchToolResultBlockParam,
  type BetaWebSearchToolResultBlockParamContent,
  type BetaWebSearchToolResultError,
  type BetaWebSearchToolResultErrorCode,
  type BetaBase64PDFBlock,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
  type BetaToolResultContentBlockParam,
} from './messages/index';
export {
  Models,
  type BetaCapabilitySupport,
  type BetaContextManagementCapability,
  type BetaEffortCapability,
  type BetaModelCapabilities,
  type BetaModelInfo,
  type BetaThinkingCapability,
  type BetaThinkingTypes,
  type ModelRetrieveParams,
  type ModelListParams,
  type BetaModelInfosPage,
} from './models';
export {
  Sessions,
  type BetaManagedAgentsAgentParams,
  type BetaManagedAgentsBranchCheckout,
  type BetaManagedAgentsCacheCreationUsage,
  type BetaManagedAgentsCommitCheckout,
  type BetaManagedAgentsDeletedSession,
  type BetaManagedAgentsFileResourceParams,
  type BetaManagedAgentsGitHubRepositoryResourceParams,
  type BetaManagedAgentsMemoryStoreResourceParam,
  type BetaManagedAgentsMultiagent,
  type BetaManagedAgentsMultiagentParams,
  type BetaManagedAgentsMultiagentRosterEntryParams,
  type BetaManagedAgentsOutcomeEvaluationResource,
  type BetaManagedAgentsSession,
  type BetaManagedAgentsSessionAgent,
  type BetaManagedAgentsSessionMultiagentCoordinator,
  type BetaManagedAgentsSessionStats,
  type BetaManagedAgentsSessionUsage,
  type SessionCreateParams,
  type SessionRetrieveParams,
  type SessionUpdateParams,
  type SessionListParams,
  type SessionDeleteParams,
  type SessionArchiveParams,
  type BetaManagedAgentsSessionsPageCursor,
} from './sessions/index';
export {
  Skills,
  type SkillCreateResponse,
  type SkillRetrieveResponse,
  type SkillListResponse,
  type SkillDeleteResponse,
  type SkillCreateParams,
  type SkillRetrieveParams,
  type SkillListParams,
  type SkillDeleteParams,
  type SkillListResponsesPageCursor,
} from './skills/index';
export {
  UserProfiles,
  type BetaUserProfile,
  type BetaUserProfileEnrollmentURL,
  type BetaUserProfileTrustGrant,
  type UserProfileCreateParams,
  type UserProfileRetrieveParams,
  type UserProfileUpdateParams,
  type UserProfileListParams,
  type UserProfileCreateEnrollmentURLParams,
  type BetaUserProfilesPageCursor,
} from './user-profiles';
export {
  Vaults,
  type BetaManagedAgentsDeletedVault,
  type BetaManagedAgentsVault,
  type VaultCreateParams,
  type VaultRetrieveParams,
  type VaultUpdateParams,
  type VaultListParams,
  type VaultDeleteParams,
  type VaultArchiveParams,
  type BetaManagedAgentsVaultsPageCursor,
} from './vaults/index';
export {
  Webhooks,
  type BetaWebhookEvent,
  type BetaWebhookEventData,
  type BetaWebhookSessionArchivedEventData,
  type BetaWebhookSessionCreatedEventData,
  type BetaWebhookSessionDeletedEventData,
  type BetaWebhookSessionIdledEventData,
  type BetaWebhookSessionOutcomeEvaluationEndedEventData,
  type BetaWebhookSessionPendingEventData,
  type BetaWebhookSessionRequiresActionEventData,
  type BetaWebhookSessionRunningEventData,
  type BetaWebhookSessionStatusIdledEventData,
  type BetaWebhookSessionStatusRescheduledEventData,
  type BetaWebhookSessionStatusRunStartedEventData,
  type BetaWebhookSessionStatusTerminatedEventData,
  type BetaWebhookSessionThreadCreatedEventData,
  type BetaWebhookSessionThreadIdledEventData,
  type BetaWebhookSessionThreadTerminatedEventData,
  type BetaWebhookVaultArchivedEventData,
  type BetaWebhookVaultCreatedEventData,
  type BetaWebhookVaultCredentialArchivedEventData,
  type BetaWebhookVaultCredentialCreatedEventData,
  type BetaWebhookVaultCredentialDeletedEventData,
  type BetaWebhookVaultCredentialRefreshFailedEventData,
  type BetaWebhookVaultDeletedEventData,
  type UnwrapWebhookEvent,
} from './webhooks';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/memory-stores/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Memories,
  type BetaManagedAgentsConflictError,
  type BetaManagedAgentsContentSha256Precondition,
  type BetaManagedAgentsDeletedMemory,
  type BetaManagedAgentsError,
  type BetaManagedAgentsMemory,
  type BetaManagedAgentsMemoryListItem,
  type BetaManagedAgentsMemoryPathConflictError,
  type BetaManagedAgentsMemoryPreconditionFailedError,
  type BetaManagedAgentsMemoryPrefix,
  type BetaManagedAgentsMemoryView,
  type BetaManagedAgentsPrecondition,
  type MemoryCreateParams,
  type MemoryRetrieveParams,
  type MemoryUpdateParams,
  type MemoryListParams,
  type MemoryDeleteParams,
  type BetaManagedAgentsMemoryListItemsPageCursor,
} from './memories';
export {
  MemoryStores,
  type BetaManagedAgentsDeletedMemoryStore,
  type BetaManagedAgentsMemoryStore,
  type MemoryStoreCreateParams,
  type MemoryStoreRetrieveParams,
  type MemoryStoreUpdateParams,
  type MemoryStoreListParams,
  type MemoryStoreDeleteParams,
  type MemoryStoreArchiveParams,
  type BetaManagedAgentsMemoryStoresPageCursor,
} from './memory-stores';
export {
  MemoryVersions,
  type BetaManagedAgentsActor,
  type BetaManagedAgentsAPIActor,
  type BetaManagedAgentsMemoryVersion,
  type BetaManagedAgentsMemoryVersionOperation,
  type BetaManagedAgentsSessionActor,
  type BetaManagedAgentsUserActor,
  type MemoryVersionRetrieveParams,
  type MemoryVersionListParams,
  type MemoryVersionRedactParams,
  type BetaManagedAgentsMemoryVersionsPageCursor,
} from './memory-versions';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/messages/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Batches,
  type BetaDeletedMessageBatch,
  type BetaMessageBatch,
  type BetaMessageBatchCanceledResult,
  type BetaMessageBatchErroredResult,
  type BetaMessageBatchExpiredResult,
  type BetaMessageBatchIndividualResponse,
  type BetaMessageBatchRequestCounts,
  type BetaMessageBatchResult,
  type BetaMessageBatchSucceededResult,
  type BatchCreateParams,
  type BatchRetrieveParams,
  type BatchListParams,
  type BatchDeleteParams,
  type BatchCancelParams,
  type BatchResultsParams,
  type BetaMessageBatchesPage,
} from './batches';
export {
  Messages,
  type BetaAdvisorMessageIterationUsage,
  type BetaAdvisorRedactedResultBlock,
  type BetaAdvisorRedactedResultBlockParam,
  type BetaAdvisorResultBlock,
  type BetaAdvisorResultBlockParam,
  type BetaAdvisorTool20260301,
  type BetaAdvisorToolResultBlock,
  type BetaAdvisorToolResultBlockParam,
  type BetaAdvisorToolResultError,
  type BetaAdvisorToolResultErrorParam,
  type BetaAllThinkingTurns,
  type BetaBase64ImageSource,
  type BetaBase64PDFSource,
  type BetaBashCodeExecutionOutputBlock,
  type BetaBashCodeExecutionOutputBlockParam,
  type BetaBashCodeExecutionResultBlock,
  type BetaBashCodeExecutionResultBlockParam,
  type BetaBashCodeExecutionToolResultBlock,
  type BetaBashCodeExecutionToolResultBlockParam,
  type BetaBashCodeExecutionToolResultError,
  type BetaBashCodeExecutionToolResultErrorParam,
  type BetaCacheControlEphemeral,
  type BetaCacheCreation,
  type BetaCitationCharLocation,
  type BetaCitationCharLocationParam,
  type BetaCitationConfig,
  type BetaCitationContentBlockLocation,
  type BetaCitationContentBlockLocationParam,
  type BetaCitationPageLocation,
  type BetaCitationPageLocationParam,
  type BetaCitationSearchResultLocation,
  type BetaCitationSearchResultLocationParam,
  type BetaCitationWebSearchResultLocationParam,
  type BetaCitationsConfigParam,
  type BetaCitationsDelta,
  type BetaCitationsWebSearchResultLocation,
  type BetaClearThinking20251015Edit,
  type BetaClearThinking20251015EditResponse,
  type BetaClearToolUses20250919Edit,
  type BetaClearToolUses20250919EditResponse,
  type BetaCodeExecutionOutputBlock,
  type BetaCodeExecutionOutputBlockParam,
  type BetaCodeExecutionResultBlock,
  type BetaCodeExecutionResultBlockParam,
  type BetaCodeExecutionTool20250522,
  type BetaCodeExecutionTool20250825,
  type BetaCodeExecutionTool20260120,
  type BetaCodeExecutionToolResultBlock,
  type BetaCodeExecutionToolResultBlockContent,
  type BetaCodeExecutionToolResultBlockParam,
  type BetaCodeExecutionToolResultBlockParamContent,
  type BetaCodeExecutionToolResultError,
  type BetaCodeExecutionToolResultErrorCode,
  type BetaCodeExecutionToolResultErrorParam,
  type BetaCompact20260112Edit,
  type BetaCompactionBlock,
  type BetaCompactionBlockParam,
  type BetaCompactionContentBlockDelta,
  type BetaCompactionIterationUsage,
  type BetaContainer,
  type BetaContainerParams,
  type BetaContainerUploadBlock,
  type BetaContainerUploadBlockParam,
  type BetaContentBlock,
  type BetaContentBlockParam,
  type BetaContentBlockSource,
  type BetaContentBlockSourceContent,
  type BetaContextManagementConfig,
  type BetaContextManagementResponse,
  type BetaCountTokensContextManagementResponse,
  type BetaDirectCaller,
  type BetaDocumentBlock,
  type BetaEncryptedCodeExecutionResultBlock,
  type BetaEncryptedCodeExecutionResultBlockParam,
  type BetaFileDocumentSource,
  type BetaFileImageSource,
  type BetaImageBlockParam,
  type BetaInputJSONDelta,
  type BetaInputTokensClearAtLeast,
  type BetaInputTokensTrigger,
  type BetaIterationsUsage,
  type BetaJSONOutputFormat,
  type BetaMCPToolResultBlock,
  type BetaMCPToolUseBlock,
  type BetaMCPToolUseBlockParam,
  type BetaMCPToolset,
  type BetaMemoryTool20250818,
  type BetaMemoryTool20250818Command,
  type BetaMemoryTool20250818CreateCommand,
  type BetaMemoryTool20250818DeleteCommand,
  type BetaMemoryTool20250818InsertCommand,
  type BetaMemoryTool20250818RenameCommand,
  type BetaMemoryTool20250818StrReplaceCommand,
  type BetaMemoryTool20250818ViewCommand,
  type BetaMessage,
  type BetaMessageDeltaUsage,
  type BetaMessageIterationUsage,
  type BetaMessageParam,
  type BetaMessageTokensCount,
  type BetaMetadata,
  type BetaOutputConfig,
  type BetaPlainTextSource,
  type BetaRawContentBlockDelta,
  type BetaRawContentBlockDeltaEvent,
  type BetaRawContentBlockStartEvent,
  type BetaRawContentBlockStopEvent,
  type BetaRawMessageDeltaEvent,
  type BetaRawMessageStartEvent,
  type BetaRawMessageStopEvent,
  type BetaRawMessageStreamEvent,
  type BetaRedactedThinkingBlock,
  type BetaRedactedThinkingBlockParam,
  type BetaRefusalStopDetails,
  type BetaRequestDocumentBlock,
  type BetaRequestMCPServerToolConfiguration,
  type BetaRequestMCPServerURLDefinition,
  type BetaRequestMCPToolResultBlockParam,
  type BetaSearchResultBlockParam,
  type BetaServerToolCaller,
  type BetaServerToolCaller20260120,
  type BetaServerToolUsage,
  type BetaServerToolUseBlock,
  type BetaServerToolUseBlockParam,
  type BetaSignatureDelta,
  type BetaSkill,
  type BetaSkillParams,
  type BetaStopReason,
  type BetaTextBlock,
  type BetaTextBlockParam,
  type BetaTextCitation,
  type BetaTextCitationParam,
  type BetaTextDelta,
  type BetaTextEditorCodeExecutionCreateResultBlock,
  type BetaTextEditorCodeExecutionCreateResultBlockParam,
  type BetaTextEditorCodeExecutionStrReplaceResultBlock,
  type BetaTextEditorCodeExecutionStrReplaceResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultBlock,
  type BetaTextEditorCodeExecutionToolResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultError,
  type BetaTextEditorCodeExecutionToolResultErrorParam,
  type BetaTextEditorCodeExecutionViewResultBlock,
  type BetaTextEditorCodeExecutionViewResultBlockParam,
  type BetaThinkingBlock,
  type BetaThinkingBlockParam,
  type BetaThinkingConfigAdaptive,
  type BetaThinkingConfigDisabled,
  type BetaThinkingConfigEnabled,
  type BetaThinkingConfigParam,
  type BetaThinkingDelta,
  type BetaThinkingTurns,
  type BetaTokenTaskBudget,
  type BetaTool,
  type BetaToolBash20241022,
  type BetaToolBash20250124,
  type BetaToolChoice,
  type BetaToolChoiceAny,
  type BetaToolChoiceAuto,
  type BetaToolChoiceNone,
  type BetaToolChoiceTool,
  type BetaToolComputerUse20241022,
  type BetaToolComputerUse20250124,
  type BetaToolComputerUse20251124,
  type BetaToolReferenceBlock,
  type BetaToolReferenceBlockParam,
  type BetaToolResultBlockParam,
  type BetaToolTextEditor20241022,
  type BetaToolTextEditor20250124,
  type BetaToolTextEditor20250429,
  type BetaToolTextEditor20250728,
  type BetaToolUnion,
  type BetaToolUseBlock,
  type BetaToolUseBlockParam,
  type BetaToolUsesKeep,
  type BetaToolUsesTrigger,
  type BetaURLImageSource,
  type BetaURLPDFSource,
  type BetaUsage,
  type BetaUserLocation,
  type BetaWebFetchBlock,
  type BetaWebFetchBlockParam,
  type BetaWebFetchTool20250910,
  type BetaWebFetchTool20260209,
  type BetaWebFetchTool20260309,
  type BetaWebFetchToolResultBlock,
  type BetaWebFetchToolResultBlockParam,
  type BetaWebFetchToolResultErrorBlock,
  type BetaWebFetchToolResultErrorBlockParam,
  type BetaWebFetchToolResultErrorCode,
  type BetaWebSearchResultBlock,
  type BetaWebSearchResultBlockParam,
  type BetaWebSearchTool20250305,
  type BetaWebSearchTool20260209,
  type BetaWebSearchToolRequestError,
  type BetaWebSearchToolResultBlock,
  type BetaWebSearchToolResultBlockContent,
  type BetaWebSearchToolResultBlockParam,
  type BetaWebSearchToolResultBlockParamContent,
  type BetaWebSearchToolResultError,
  type BetaWebSearchToolResultErrorCode,
  type BetaBase64PDFBlock,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
  type BetaMessageStreamParams,
  type BetaToolSearchToolBm25_20251119,
  type BetaToolSearchToolRegex20251119,
  type BetaToolSearchToolResultBlock,
  type BetaToolSearchToolResultBlockParam,
  type BetaToolSearchToolResultError,
  type BetaToolSearchToolResultErrorParam,
  type BetaToolSearchToolSearchResultBlock,
  type BetaToolSearchToolSearchResultBlockParam,
  type BetaMCPToolConfig,
  type BetaMCPToolDefaultConfig,
  type BetaToolResultContentBlockParam,
} from './messages';
export { BetaToolRunner, type BetaToolRunnerParams, ToolError } from './messages';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/sessions/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Events,
  type BetaManagedAgentsAgentCustomToolUseEvent,
  type BetaManagedAgentsAgentMCPToolResultEvent,
  type BetaManagedAgentsAgentMCPToolUseEvent,
  type BetaManagedAgentsAgentMessageEvent,
  type BetaManagedAgentsAgentThinkingEvent,
  type BetaManagedAgentsAgentThreadContextCompactedEvent,
  type BetaManagedAgentsAgentThreadMessageReceivedEvent,
  type BetaManagedAgentsAgentThreadMessageSentEvent,
  type BetaManagedAgentsAgentToolResultEvent,
  type BetaManagedAgentsAgentToolUseEvent,
  type BetaManagedAgentsBase64DocumentSource,
  type BetaManagedAgentsBase64ImageSource,
  type BetaManagedAgentsBillingError,
  type BetaManagedAgentsDocumentBlock,
  type BetaManagedAgentsEventParams,
  type BetaManagedAgentsFileDocumentSource,
  type BetaManagedAgentsFileImageSource,
  type BetaManagedAgentsFileRubric,
  type BetaManagedAgentsFileRubricParams,
  type BetaManagedAgentsImageBlock,
  type BetaManagedAgentsMCPAuthenticationFailedError,
  type BetaManagedAgentsMCPConnectionFailedError,
  type BetaManagedAgentsModelOverloadedError,
  type BetaManagedAgentsModelRateLimitedError,
  type BetaManagedAgentsModelRequestFailedError,
  type BetaManagedAgentsPlainTextDocumentSource,
  type BetaManagedAgentsRetryStatusExhausted,
  type BetaManagedAgentsRetryStatusRetrying,
  type BetaManagedAgentsRetryStatusTerminal,
  type BetaManagedAgentsSendSessionEvents,
  type BetaManagedAgentsSessionDeletedEvent,
  type BetaManagedAgentsSessionEndTurn,
  type BetaManagedAgentsSessionErrorEvent,
  type BetaManagedAgentsSessionEvent,
  type BetaManagedAgentsSessionRequiresAction,
  type BetaManagedAgentsSessionRetriesExhausted,
  type BetaManagedAgentsSessionStatusIdleEvent,
  type BetaManagedAgentsSessionStatusRescheduledEvent,
  type BetaManagedAgentsSessionStatusRunningEvent,
  type BetaManagedAgentsSessionStatusTerminatedEvent,
  type BetaManagedAgentsSessionThreadCreatedEvent,
  type BetaManagedAgentsSessionThreadStatusIdleEvent,
  type BetaManagedAgentsSessionThreadStatusRescheduledEvent,
  type BetaManagedAgentsSessionThreadStatusRunningEvent,
  type BetaManagedAgentsSessionThreadStatusTerminatedEvent,
  type BetaManagedAgentsSpanModelRequestEndEvent,
  type BetaManagedAgentsSpanModelRequestStartEvent,
  type BetaManagedAgentsSpanModelUsage,
  type BetaManagedAgentsSpanOutcomeEvaluationEndEvent,
  type BetaManagedAgentsSpanOutcomeEvaluationOngoingEvent,
  type BetaManagedAgentsSpanOutcomeEvaluationStartEvent,
  type BetaManagedAgentsStreamSessionEvents,
  type BetaManagedAgentsTextBlock,
  type BetaManagedAgentsTextRubric,
  type BetaManagedAgentsTextRubricParams,
  type BetaManagedAgentsUnknownError,
  type BetaManagedAgentsURLDocumentSource,
  type BetaManagedAgentsURLImageSource,
  type BetaManagedAgentsUserCustomToolResultEvent,
  type BetaManagedAgentsUserCustomToolResultEventParams,
  type BetaManagedAgentsUserDefineOutcomeEvent,
  type BetaManagedAgentsUserDefineOutcomeEventParams,
  type BetaManagedAgentsUserInterruptEvent,
  type BetaManagedAgentsUserInterruptEventParams,
  type BetaManagedAgentsUserMessageEvent,
  type BetaManagedAgentsUserMessageEventParams,
  type BetaManagedAgentsUserToolConfirmationEvent,
  type BetaManagedAgentsUserToolConfirmationEventParams,
  type EventListParams,
  type EventSendParams,
  type EventStreamParams,
  type BetaManagedAgentsSessionEventsPageCursor,
} from './events';
export {
  Resources,
  type BetaManagedAgentsDeleteSessionResource,
  type BetaManagedAgentsFileResource,
  type BetaManagedAgentsGitHubRepositoryResource,
  type BetaManagedAgentsMemoryStoreResource,
  type BetaManagedAgentsSessionResource,
  type ResourceRetrieveResponse,
  type ResourceUpdateResponse,
  type ResourceRetrieveParams,
  type ResourceUpdateParams,
  type ResourceListParams,
  type ResourceDeleteParams,
  type ResourceAddParams,
  type BetaManagedAgentsSessionResourcesPageCursor,
} from './resources';
export {
  Sessions,
  type BetaManagedAgentsAgentParams,
  type BetaManagedAgentsBranchCheckout,
  type BetaManagedAgentsCacheCreationUsage,
  type BetaManagedAgentsCommitCheckout,
  type BetaManagedAgentsDeletedSession,
  type BetaManagedAgentsFileResourceParams,
  type BetaManagedAgentsGitHubRepositoryResourceParams,
  type BetaManagedAgentsMemoryStoreResourceParam,
  type BetaManagedAgentsMultiagent,
  type BetaManagedAgentsMultiagentParams,
  type BetaManagedAgentsMultiagentRosterEntryParams,
  type BetaManagedAgentsOutcomeEvaluationResource,
  type BetaManagedAgentsSession,
  type BetaManagedAgentsSessionAgent,
  type BetaManagedAgentsSessionMultiagentCoordinator,
  type BetaManagedAgentsSessionStats,
  type BetaManagedAgentsSessionUsage,
  type SessionCreateParams,
  type SessionRetrieveParams,
  type SessionUpdateParams,
  type SessionListParams,
  type SessionDeleteParams,
  type SessionArchiveParams,
  type BetaManagedAgentsSessionsPageCursor,
} from './sessions';
export {
  Threads,
  type BetaManagedAgentsSessionThread,
  type BetaManagedAgentsSessionThreadAgent,
  type BetaManagedAgentsSessionThreadStats,
  type BetaManagedAgentsSessionThreadStatus,
  type BetaManagedAgentsSessionThreadUsage,
  type BetaManagedAgentsStreamSessionThreadEvents,
  type ThreadRetrieveParams,
  type ThreadListParams,
  type ThreadArchiveParams,
  type BetaManagedAgentsSessionThreadsPageCursor,
} from './threads/index';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/sessions/threads/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export { Events, type EventListParams, type EventStreamParams } from './events';
export {
  Threads,
  type BetaManagedAgentsSessionThread,
  type BetaManagedAgentsSessionThreadAgent,
  type BetaManagedAgentsSessionThreadStats,
  type BetaManagedAgentsSessionThreadStatus,
  type BetaManagedAgentsSessionThreadUsage,
  type BetaManagedAgentsStreamSessionThreadEvents,
  type ThreadRetrieveParams,
  type ThreadListParams,
  type ThreadArchiveParams,
  type BetaManagedAgentsSessionThreadsPageCursor,
} from './threads';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/skills/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Skills,
  type SkillCreateResponse,
  type SkillRetrieveResponse,
  type SkillListResponse,
  type SkillDeleteResponse,
  type SkillCreateParams,
  type SkillRetrieveParams,
  type SkillListParams,
  type SkillDeleteParams,
  type SkillListResponsesPageCursor,
} from './skills';
export {
  Versions,
  type VersionCreateResponse,
  type VersionRetrieveResponse,
  type VersionListResponse,
  type VersionDeleteResponse,
  type VersionCreateParams,
  type VersionRetrieveParams,
  type VersionListParams,
  type VersionDeleteParams,
  type VersionListResponsesPageCursor,
} from './versions';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/vaults/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Credentials,
  type BetaManagedAgentsCredential,
  type BetaManagedAgentsCredentialValidation,
  type BetaManagedAgentsCredentialValidationStatus,
  type BetaManagedAgentsDeletedCredential,
  type BetaManagedAgentsMCPOAuthAuthResponse,
  type BetaManagedAgentsMCPOAuthCreateParams,
  type BetaManagedAgentsMCPOAuthRefreshParams,
  type BetaManagedAgentsMCPOAuthRefreshResponse,
  type BetaManagedAgentsMCPOAuthRefreshUpdateParams,
  type BetaManagedAgentsMCPOAuthUpdateParams,
  type BetaManagedAgentsMCPProbe,
  type BetaManagedAgentsRefreshHTTPResponse,
  type BetaManagedAgentsRefreshObject,
  type BetaManagedAgentsStaticBearerAuthResponse,
  type BetaManagedAgentsStaticBearerCreateParams,
  type BetaManagedAgentsStaticBearerUpdateParams,
  type BetaManagedAgentsTokenEndpointAuthBasicParam,
  type BetaManagedAgentsTokenEndpointAuthBasicResponse,
  type BetaManagedAgentsTokenEndpointAuthBasicUpdateParam,
  type BetaManagedAgentsTokenEndpointAuthNoneParam,
  type BetaManagedAgentsTokenEndpointAuthNoneResponse,
  type BetaManagedAgentsTokenEndpointAuthPostParam,
  type BetaManagedAgentsTokenEndpointAuthPostResponse,
  type BetaManagedAgentsTokenEndpointAuthPostUpdateParam,
  type CredentialCreateParams,
  type CredentialRetrieveParams,
  type CredentialUpdateParams,
  type CredentialListParams,
  type CredentialDeleteParams,
  type CredentialArchiveParams,
  type CredentialMCPOAuthValidateParams,
  type BetaManagedAgentsCredentialsPageCursor,
} from './credentials';
export {
  Vaults,
  type BetaManagedAgentsDeletedVault,
  type BetaManagedAgentsVault,
  type VaultCreateParams,
  type VaultRetrieveParams,
  type VaultUpdateParams,
  type VaultListParams,
  type VaultDeleteParams,
  type VaultArchiveParams,
  type BetaManagedAgentsVaultsPageCursor,
} from './vaults';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export * from './shared';
export {
  Beta,
  type AnthropicBeta,
  type BetaAPIError,
  type BetaAuthenticationError,
  type BetaBillingError,
  type BetaError,
  type BetaErrorResponse,
  type BetaGatewayTimeoutError,
  type BetaInvalidRequestError,
  type BetaNotFoundError,
  type BetaOverloadedError,
  type BetaPermissionError,
  type BetaRateLimitError,
} from './beta/beta';
export {
  Completions,
  type Completion,
  type CompletionCreateParams,
  type CompletionCreateParamsNonStreaming,
  type CompletionCreateParamsStreaming,
} from './completions';
export {
  Messages,
  type Base64ImageSource,
  type Base64PDFSource,
  type BashCodeExecutionOutputBlock,
  type BashCodeExecutionOutputBlockParam,
  type BashCodeExecutionResultBlock,
  type BashCodeExecutionResultBlockParam,
  type BashCodeExecutionToolResultBlock,
  type BashCodeExecutionToolResultBlockParam,
  type BashCodeExecutionToolResultError,
  type BashCodeExecutionToolResultErrorCode,
  type BashCodeExecutionToolResultErrorParam,
  type CacheControlEphemeral,
  type CacheCreation,
  type CitationCharLocation,
  type CitationCharLocationParam,
  type CitationContentBlockLocation,
  type CitationContentBlockLocationParam,
  type CitationPageLocation,
  type CitationPageLocationParam,
  type CitationSearchResultLocationParam,
  type CitationWebSearchResultLocationParam,
  type CitationsConfig,
  type CitationsConfigParam,
  type CitationsDelta,
  type CitationsSearchResultLocation,
  type CitationsWebSearchResultLocation,
  type CodeExecutionOutputBlock,
  type CodeExecutionOutputBlockParam,
  type CodeExecutionResultBlock,
  type CodeExecutionResultBlockParam,
  type CodeExecutionTool20250522,
  type CodeExecutionTool20250825,
  type CodeExecutionTool20260120,
  type CodeExecutionToolResultBlock,
  type CodeExecutionToolResultBlockContent,
  type CodeExecutionToolResultBlockParam,
  type CodeExecutionToolResultBlockParamContent,
  type CodeExecutionToolResultError,
  type CodeExecutionToolResultErrorCode,
  type CodeExecutionToolResultErrorParam,
  type Container,
  type ContainerUploadBlock,
  type ContainerUploadBlockParam,
  type ContentBlock,
  type ContentBlockParam,
  type ContentBlockStartEvent,
  type ContentBlockStopEvent,
  type ContentBlockSource,
  type ContentBlockSourceContent,
  type DirectCaller,
  type DocumentBlock,
  type DocumentBlockParam,
  type EncryptedCodeExecutionResultBlock,
  type EncryptedCodeExecutionResultBlockParam,
  type ImageBlockParam,
  type InputJSONDelta,
  type JSONOutputFormat,
  type MemoryTool20250818,
  type Message,
  type MessageCountTokensTool,
  type MessageDeltaEvent,
  type MessageDeltaUsage,
  type MessageParam,
  type MessageStreamParams,
  type MessageTokensCount,
  type Metadata,
  type Model,
  type OutputConfig,
  type PlainTextSource,
  type RawContentBlockDelta,
  type RawContentBlockDeltaEvent,
  type RawContentBlockStartEvent,
  type RawContentBlockStopEvent,
  type RawMessageDeltaEvent,
  type RawMessageStartEvent,
  type RawMessageStopEvent,
  type RawMessageStreamEvent,
  type RedactedThinkingBlock,
  type RedactedThinkingBlockParam,
  type RefusalStopDetails,
  type SearchResultBlockParam,
  type ServerToolCaller,
  type ServerToolCaller20260120,
  type ServerToolUsage,
  type ServerToolUseBlock,
  type ServerToolUseBlockParam,
  type SignatureDelta,
  type StopReason,
  type TextBlock,
  type TextBlockParam,
  type TextCitation,
  type TextCitationParam,
  type TextDelta,
  type TextEditorCodeExecutionCreateResultBlock,
  type TextEditorCodeExecutionCreateResultBlockParam,
  type TextEditorCodeExecutionStrReplaceResultBlock,
  type TextEditorCodeExecutionStrReplaceResultBlockParam,
  type TextEditorCodeExecutionToolResultBlock,
  type TextEditorCodeExecutionToolResultBlockParam,
  type TextEditorCodeExecutionToolResultError,
  type TextEditorCodeExecutionToolResultErrorCode,
  type TextEditorCodeExecutionToolResultErrorParam,
  type TextEditorCodeExecutionViewResultBlock,
  type TextEditorCodeExecutionViewResultBlockParam,
  type ThinkingBlock,
  type ThinkingBlockParam,
  type ThinkingConfigAdaptive,
  type ThinkingConfigDisabled,
  type ThinkingConfigEnabled,
  type ThinkingConfigParam,
  type ThinkingDelta,
  type Tool,
  type ToolBash20250124,
  type ToolChoice,
  type ToolChoiceAny,
  type ToolChoiceAuto,
  type ToolChoiceNone,
  type ToolChoiceTool,
  type ToolReferenceBlock,
  type ToolReferenceBlockParam,
  type ToolResultBlockParam,
  type ToolSearchToolBm25_20251119,
  type ToolSearchToolRegex20251119,
  type ToolSearchToolResultBlock,
  type ToolSearchToolResultBlockParam,
  type ToolSearchToolResultError,
  type ToolSearchToolResultErrorCode,
  type ToolSearchToolResultErrorParam,
  type ToolSearchToolSearchResultBlock,
  type ToolSearchToolSearchResultBlockParam,
  type ToolTextEditor20250124,
  type ToolTextEditor20250429,
  type ToolTextEditor20250728,
  type ToolUnion,
  type ToolUseBlock,
  type ToolUseBlockParam,
  type URLImageSource,
  type URLPDFSource,
  type Usage,
  type UserLocation,
  type WebFetchBlock,
  type WebFetchBlockParam,
  type WebFetchTool20250910,
  type WebFetchTool20260209,
  type WebFetchTool20260309,
  type WebFetchToolResultBlock,
  type WebFetchToolResultBlockParam,
  type WebFetchToolResultErrorBlock,
  type WebFetchToolResultErrorBlockParam,
  type WebFetchToolResultErrorCode,
  type WebSearchResultBlock,
  type WebSearchResultBlockParam,
  type WebSearchTool20250305,
  type WebSearchTool20260209,
  type WebSearchToolRequestError,
  type WebSearchToolResultBlock,
  type WebSearchToolResultBlockContent,
  type WebSearchToolResultBlockParam,
  type WebSearchToolResultBlockParamContent,
  type WebSearchToolResultError,
  type WebSearchToolResultErrorCode,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
} from './messages/messages';
export {
  Models,
  type CapabilitySupport,
  type ContextManagementCapability,
  type EffortCapability,
  type ModelCapabilities,
  type ModelInfo,
  type ThinkingCapability,
  type ThinkingTypes,
  type ModelRetrieveParams,
  type ModelListParams,
  type ModelInfosPage,
} from './models';
```
### `spine/platform/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/messages/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Batches,
  type DeletedMessageBatch,
  type MessageBatch,
  type MessageBatchCanceledResult,
  type MessageBatchErroredResult,
  type MessageBatchExpiredResult,
  type MessageBatchIndividualResponse,
  type MessageBatchRequestCounts,
  type MessageBatchResult,
  type MessageBatchSucceededResult,
  type BatchCreateParams,
  type BatchListParams,
  type MessageBatchesPage,
} from './batches';
export {
  Messages,
  type Base64ImageSource,
  type Base64PDFSource,
  type BashCodeExecutionOutputBlock,
  type BashCodeExecutionOutputBlockParam,
  type BashCodeExecutionResultBlock,
  type BashCodeExecutionResultBlockParam,
  type BashCodeExecutionToolResultBlock,
  type BashCodeExecutionToolResultBlockParam,
  type BashCodeExecutionToolResultError,
  type BashCodeExecutionToolResultErrorCode,
  type BashCodeExecutionToolResultErrorParam,
  type CacheControlEphemeral,
  type CacheCreation,
  type CitationCharLocation,
  type CitationCharLocationParam,
  type CitationContentBlockLocation,
  type CitationContentBlockLocationParam,
  type CitationPageLocation,
  type CitationPageLocationParam,
  type CitationSearchResultLocationParam,
  type CitationWebSearchResultLocationParam,
  type CitationsConfig,
  type CitationsConfigParam,
  type CitationsDelta,
  type CitationsSearchResultLocation,
  type CitationsWebSearchResultLocation,
  type CodeExecutionOutputBlock,
  type CodeExecutionOutputBlockParam,
  type CodeExecutionResultBlock,
  type CodeExecutionResultBlockParam,
  type CodeExecutionTool20250522,
  type CodeExecutionTool20250825,
  type CodeExecutionTool20260120,
  type CodeExecutionToolResultBlock,
  type CodeExecutionToolResultBlockContent,
  type CodeExecutionToolResultBlockParam,
  type CodeExecutionToolResultBlockParamContent,
  type CodeExecutionToolResultError,
  type CodeExecutionToolResultErrorCode,
  type CodeExecutionToolResultErrorParam,
  type Container,
  type ContainerUploadBlock,
  type ContainerUploadBlockParam,
  type ContentBlock,
  type ContentBlockParam,
  type ContentBlockStartEvent,
  type ContentBlockStopEvent,
  type ContentBlockSource,
  type ContentBlockSourceContent,
  type DirectCaller,
  type DocumentBlock,
  type DocumentBlockParam,
  type EncryptedCodeExecutionResultBlock,
  type EncryptedCodeExecutionResultBlockParam,
  type ImageBlockParam,
  type InputJSONDelta,
  type JSONOutputFormat,
  type MemoryTool20250818,
  type Message,
  type MessageCountTokensTool,
  type MessageDeltaEvent,
  type MessageDeltaUsage,
  type MessageParam,
  type MessageTokensCount,
  type Metadata,
  type Model,
  type OutputConfig,
  type PlainTextSource,
  type RawContentBlockDelta,
  type RawContentBlockDeltaEvent,
  type RawContentBlockStartEvent,
  type RawContentBlockStopEvent,
  type RawMessageDeltaEvent,
  type RawMessageStartEvent,
  type RawMessageStopEvent,
  type RawMessageStreamEvent,
  type RedactedThinkingBlock,
  type RedactedThinkingBlockParam,
  type RefusalStopDetails,
  type SearchResultBlockParam,
  type ServerToolCaller,
  type ServerToolCaller20260120,
  type ServerToolUsage,
  type ServerToolUseBlock,
  type ServerToolUseBlockParam,
  type SignatureDelta,
  type StopReason,
  type TextBlock,
  type TextBlockParam,
  type TextCitation,
  type TextCitationParam,
  type TextDelta,
  type TextEditorCodeExecutionCreateResultBlock,
  type TextEditorCodeExecutionCreateResultBlockParam,
  type TextEditorCodeExecutionStrReplaceResultBlock,
  type TextEditorCodeExecutionStrReplaceResultBlockParam,
  type TextEditorCodeExecutionToolResultBlock,
  type TextEditorCodeExecutionToolResultBlockParam,
  type TextEditorCodeExecutionToolResultError,
  type TextEditorCodeExecutionToolResultErrorCode,
  type TextEditorCodeExecutionToolResultErrorParam,
  type TextEditorCodeExecutionViewResultBlock,
  type TextEditorCodeExecutionViewResultBlockParam,
  type ThinkingBlock,
  type ThinkingBlockParam,
  type ThinkingConfigAdaptive,
  type ThinkingConfigDisabled,
  type ThinkingConfigEnabled,
  type ThinkingConfigParam,
  type ThinkingDelta,
  type Tool,
  type ToolBash20250124,
  type ToolChoice,
  type ToolChoiceAny,
  type ToolChoiceAuto,
  type ToolChoiceNone,
  type ToolChoiceTool,
  type ToolReferenceBlock,
  type ToolReferenceBlockParam,
  type ToolResultBlockParam,
  type ToolSearchToolBm25_20251119,
  type ToolSearchToolRegex20251119,
  type ToolSearchToolResultBlock,
  type ToolSearchToolResultBlockParam,
  type ToolSearchToolResultError,
  type ToolSearchToolResultErrorCode,
  type ToolSearchToolResultErrorParam,
  type ToolSearchToolSearchResultBlock,
  type ToolSearchToolSearchResultBlockParam,
  type ToolTextEditor20250124,
  type ToolTextEditor20250429,
  type ToolTextEditor20250728,
  type ToolUnion,
  type ToolUseBlock,
  type ToolUseBlockParam,
  type URLImageSource,
  type URLPDFSource,
  type Usage,
  type UserLocation,
  type WebFetchBlock,
  type WebFetchBlockParam,
  type WebFetchTool20250910,
  type WebFetchTool20260209,
  type WebFetchTool20260309,
  type WebFetchToolResultBlock,
  type WebFetchToolResultBlockParam,
  type WebFetchToolResultErrorBlock,
  type WebFetchToolResultErrorBlockParam,
  type WebFetchToolResultErrorCode,
  type WebSearchResultBlock,
  type WebSearchResultBlockParam,
  type WebSearchTool20250305,
  type WebSearchTool20260209,
  type WebSearchToolRequestError,
  type WebSearchToolResultBlock,
  type WebSearchToolResultBlockContent,
  type WebSearchToolResultBlockParam,
  type WebSearchToolResultBlockParamContent,
  type WebSearchToolResultError,
  type WebSearchToolResultErrorCode,
  type MessageStreamEvent,
  type MessageStartEvent,
  type MessageStopEvent,
  type ContentBlockDeltaEvent,
  type MessageCreateParams,
  type MessageCreateParamsBase,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
} from './messages';
```
### `spine/platform/platform/worker/node_modules/zod/src/index.ts`
```typescript
import * as z from "./v4/classic/external.js";
export * from "./v4/classic/external.js";
export { z };
export default z;
```
### `spine/platform/platform/worker/node_modules/zod/src/locales/index.ts`
```typescript
export * from "../v4/locales/index.js";
```
### `spine/platform/platform/worker/node_modules/zod/src/mini/index.ts`
```typescript
import * as z from "../v4/mini/external.js";
export * from "../v4/mini/external.js";
export { z };
```
### `spine/platform/platform/worker/node_modules/zod/src/v3/benchmarks/index.ts`
```typescript
import type Benchmark from "benchmark";
import datetimeBenchmarks from "./datetime.js";
import discriminatedUnionBenchmarks from "./discriminatedUnion.js";
import ipv4Benchmarks from "./ipv4.js";
import objectBenchmarks from "./object.js";
import primitiveBenchmarks from "./primitives.js";
import realworld from "./realworld.js";
import stringBenchmarks from "./string.js";
import unionBenchmarks from "./union.js";
const argv = process.argv.slice(2);
let suites: Benchmark.Suite[] = [];
if (!argv.length) {
  suites = [
    ...realworld.suites,
    ...primitiveBenchmarks.suites,
    ...stringBenchmarks.suites,
    ...objectBenchmarks.suites,
    ...unionBenchmarks.suites,
    ...discriminatedUnionBenchmarks.suites,
  ];
} else {
  if (argv.includes("--realworld")) {
    suites.push(...realworld.suites);
  }
  if (argv.includes("--primitives")) {
    suites.push(...primitiveBenchmarks.suites);
  }
  if (argv.includes("--string")) {
    suites.push(...stringBenchmarks.suites);
  }
  if (argv.includes("--object")) {
    suites.push(...objectBenchmarks.suites);
  }
  if (argv.includes("--union")) {
    suites.push(...unionBenchmarks.suites);
  }
  if (argv.includes("--discriminatedUnion")) {
    suites.push(...datetimeBenchmarks.suites);
  }
  if (argv.includes("--datetime")) {
    suites.push(...datetimeBenchmarks.suites);
  }
  if (argv.includes("--ipv4")) {
    suites.push(...ipv4Benchmarks.suites);
  }
}
for (const suite of suites) {
  suite.run({});
}
// exit on Ctrl-C
process.on("SIGINT", function () {
  console.log("Exiting...");
  process.exit();
});
```
### `spine/platform/platform/worker/node_modules/zod/src/v3/index.ts`
```typescript
import * as z from "./external.js";
export * from "./external.js";
export { z };
export default z;
```
### `spine/platform/platform/worker/node_modules/zod/src/v4/classic/index.ts`
```typescript
import * as z from "./external.js";
export { z };
export * from "./external.js";
export default z;
```
### `spine/platform/platform/worker/node_modules/zod/src/v4/core/index.ts`
```typescript
export * from "./core.js";
export * from "./parse.js";
export * from "./errors.js";
export * from "./schemas.js";
export * from "./checks.js";
export * from "./versions.js";
export * as util from "./util.js";
export * as regexes from "./regexes.js";
export * as locales from "../locales/index.js";
export * from "./registries.js";
export * from "./doc.js";
export * from "./api.js";
export * from "./to-json-schema.js";
export { toJSONSchema } from "./json-schema-processors.js";
export { JSONSchemaGenerator } from "./json-schema-generator.js";
export * as JSONSchema from "./json-schema.js";
```
### `spine/platform/platform/worker/node_modules/zod/src/v4/index.ts`
```typescript
import z4 from "./classic/index.js";
export * from "./classic/index.js";
export default z4;
```
### `spine/platform/platform/worker/node_modules/zod/src/v4/locales/index.ts`
```typescript
export { default as ar } from "./ar.js";
export { default as az } from "./az.js";
export { default as be } from "./be.js";
export { default as bg } from "./bg.js";
export { default as ca } from "./ca.js";
export { default as cs } from "./cs.js";
export { default as da } from "./da.js";
export { default as de } from "./de.js";
export { default as el } from "./el.js";
export { default as en } from "./en.js";
export { default as eo } from "./eo.js";
export { default as es } from "./es.js";
export { default as fa } from "./fa.js";
export { default as fi } from "./fi.js";
export { default as fr } from "./fr.js";
export { default as frCA } from "./fr-CA.js";
export { default as he } from "./he.js";
export { default as hr } from "./hr.js";
export { default as hu } from "./hu.js";
export { default as hy } from "./hy.js";
export { default as id } from "./id.js";
export { default as is } from "./is.js";
export { default as it } from "./it.js";
export { default as ja } from "./ja.js";
export { default as ka } from "./ka.js";
export { default as kh } from "./kh.js";
export { default as km } from "./km.js";
export { default as ko } from "./ko.js";
export { default as lt } from "./lt.js";
export { default as mk } from "./mk.js";
export { default as ms } from "./ms.js";
export { default as nl } from "./nl.js";
export { default as no } from "./no.js";
export { default as ota } from "./ota.js";
export { default as ps } from "./ps.js";
export { default as pl } from "./pl.js";
export { default as pt } from "./pt.js";
export { default as ro } from "./ro.js";
export { default as ru } from "./ru.js";
export { default as sl } from "./sl.js";
export { default as sv } from "./sv.js";
export { default as ta } from "./ta.js";
export { default as th } from "./th.js";
export { default as tr } from "./tr.js";
export { default as ua } from "./ua.js";
export { default as uk } from "./uk.js";
export { default as ur } from "./ur.js";
export { default as uz } from "./uz.js";
export { default as vi } from "./vi.js";
export { default as zhCN } from "./zh-CN.js";
export { default as zhTW } from "./zh-TW.js";
export { default as yo } from "./yo.js";
```
### `spine/platform/platform/worker/node_modules/zod/src/v4/mini/index.ts`
```typescript
import * as z from "./external.js";
export * from "./external.js";
export { z };
```
### `spine/platform/platform/worker/node_modules/zod/src/v4-mini/index.ts`
```typescript
import * as z from "../v4/mini/external.js";
export * from "../v4/mini/external.js";
export { z };
```
### `spine/platform/platform/worker/worker/index.ts`
```typescript
import 'dotenv/config';
import './sentry.js';
import { Worker, type Job } from 'bullmq';
import type { Redis as RedisClient } from 'ioredis';
import type { Server } from 'http';
import { createRedisConnection, QUEUE_NAME, type PdfJobData, type PdfJobResult } from './queue.js';
import {
  downloadFiles,
  uploadResults,
  uploadFile,
  fileExists,
  getSignedUrl,
} from './firebase.js';
import { generateOdpor, closeMcp } from './generate-odpor.js';
import { markdownToDocx } from '../scripts/lib/docx-writer.js';
import { docxToPdf } from './pdf.js';
import { sendResultEmail } from './email.js';
import { logger as baseLogger } from '../lib/logger.js';
import { startHealthServer } from '../lib/health.js';
const logger = baseLogger.child({ service: 'rozporuj-worker' });
// Paths written under results/<sessionId>/ by a successful run. Used to
// short-circuit an idempotent retry without re-running Claude.
const resultPaths = (sessionId: string) => ({
  pdf: `results/${sessionId}/odpor.pdf`,
  docx: `results/${sessionId}/odpor.docx`,
  conversation: `results/${sessionId}/conversation.md`,
});
/** H7 — idempotent short-circuit. If a prior run of this sessionId already
 *  uploaded results/<sessionId>/odpor.pdf, we re-issue signed URLs and resend
 *  the email without re-running Claude / LibreOffice. Matches the CLAUDE.md
 *  rule "All job handlers must be idempotent". */
export const maybeShortCircuit = async (
  sessionId: string,
): Promise<{
  outputPath: string;
  downloadUrl: string;
  docxUrl: string;
  conversationUrl: string;
} | null> => {
  const paths = resultPaths(sessionId);
  const pdfExists = await fileExists(paths.pdf).catch(() => false);
  if (!pdfExists) return null;
  const [downloadUrl, docxUrl, conversationUrl] = await Promise.all([
    getSignedUrl(paths.pdf),
    getSignedUrl(paths.docx).catch(() => ''),
    getSignedUrl(paths.conversation).catch(() => ''),
  ]);
  return { outputPath: paths.pdf, downloadUrl, docxUrl, conversationUrl };
};
export const processJob = async (job: Job<PdfJobData>): Promise<PdfJobResult> => {
  const { sessionId, email, firstName, lastName } = job.data;
  const log = logger.child({ jobId: job.id, sessionId });
  log.info('Job started');
  // H7 idempotency — short-circuit if results already uploaded.
  const cached = await maybeShortCircuit(sessionId);
  if (cached) {
    log.info({ outputPath: cached.outputPath }, 'Idempotent replay: result already exists, resending email only');
    await job.updateProgress(95);
    await sendResultEmail({ to: email, firstName, downloadUrl: cached.downloadUrl, docxUrl: cached.docxUrl });
    await job.updateProgress(100);
    return {
      downloadUrl: cached.downloadUrl,
      docxUrl: cached.docxUrl,
      conversationUrl: cached.conversationUrl,
      outputPath: cached.outputPath,
    };
  }
  // 1. Download uploaded files from Firebase
  await job.updateProgress(10);
  log.info('Downloading files from Firebase...');
  const files = await downloadFiles(sessionId);
  if (files.length === 0) throw new Error(`No files found for session ${sessionId}`);
  log.info({ fileCount: files.length }, 'Files downloaded');
  // 2. Generate legal analysis via Claude API + MCP tools
  await job.updateProgress(20);
  const { markdown, conversationLog } = await generateOdpor(files, { firstName, lastName, prompt: job.data.prompt, userNotes: job.data.userNotes }, (msg) => {
    log.info(msg);
  });
  log.info({ length: markdown.length }, 'Legal analysis generated');
  // 3. Markdown → DOCX
  await job.updateProgress(70);
  log.info('Converting markdown to DOCX...');
  const docxBuffer = await markdownToDocx(markdown, `Odpor proti pokutě — ${firstName} ${lastName}`, {
    style: 'legal',
    showTitle: false,
    headerText: 'Rozporuj.com',
  });
  // 4. DOCX → PDF
  await job.updateProgress(80);
  log.info('Converting DOCX to PDF...');
  const pdfBuffer = await docxToPdf(docxBuffer);
  log.info({ pdfSize: pdfBuffer.length }, 'PDF generated');
  // 5. Upload PDF + DOCX + conversation log to Firebase
  await job.updateProgress(90);
  log.info('Uploading results to Firebase...');
  const [{ outputPath, downloadUrl, docxUrl }, conversationUrl] = await Promise.all([
    uploadResults(sessionId, pdfBuffer, docxBuffer),
    uploadFile(`results/${sessionId}/conversation.md`, Buffer.from(conversationLog, 'utf-8'), 'text/markdown'),
  ]);
  // 6. Send email
  await job.updateProgress(95);
  log.info('Sending result email...');
  await sendResultEmail({ to: email, firstName, downloadUrl, docxUrl });
  await job.updateProgress(100);
  log.info({ outputPath }, 'Job completed successfully');
  return { downloadUrl, docxUrl, conversationUrl, outputPath };
};
// --- Worker setup ---
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);
// Hard ceiling on the full shutdown sequence. Railway typically sends SIGKILL
// ~30s after SIGTERM; we bound the graceful path inside that window.
export const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || '30000', 10);
// M6: Without removeOnComplete / removeOnFail, BullMQ keeps every job record in
// Redis forever — a long-lived worker accumulates thousands of entries and
// eventually exceeds the Railway Redis memory ceiling. These defaults are
// exported so tests can assert the values and callers can override per-queue.
export const REMOVE_ON_COMPLETE: { count: number } = { count: 100 };
export const REMOVE_ON_FAIL: { count: number } = { count: 200 };
// M4: Per-job wallclock budget. Exposed for tests.
export const MAX_ITER_BUDGET_MS = parseInt(process.env.WORKER_MAX_ITER_BUDGET_MS || '300000', 10); // 5 min default
/**
 * H1/H5 — ordered, bounded graceful shutdown.
 *
 * Order: worker.close() (BullMQ drains in-flight jobs) → connection.quit()
 * (ioredis flushes + quits) → closeMcp() (release MCP singleton).
 *
 * Each step is awaited. The entire sequence is bounded by SHUTDOWN_TIMEOUT_MS
 * via Promise.race — if any step hangs (e.g. Redis partition) we still
 * terminate instead of being SIGKILLed by Railway.
 *
 * Exit code is 0 only if every step completed cleanly. On any error or
 * timeout we exit 1 so Railway / systemd can distinguish a drained shutdown
 * from a failed one.
 */
export const runShutdown = async (deps: {
  worker: Pick<Worker, 'close'>;
  connection: Pick<RedisClient, 'quit'>;
  closeMcpClient: () => void;
  healthServer?: Server;
  log: Pick<typeof logger, 'info' | 'error' | 'warn'>;
  timeoutMs: number;
}): Promise<number> => {
  const { worker, connection, closeMcpClient, healthServer, log, timeoutMs } = deps;
  const drain = (async () => {
    // Step 1: close health server if present
    if (healthServer) {
      log.info('Closing health server...');
      await new Promise<void>((resolve) => {
        healthServer.close(() => {
          resolve();
        });
      });
    }
    // Step 2: drain BullMQ worker. `worker.close()` awaits active jobs,
    // stops the queue consumer, and releases locks.
    log.info('Draining BullMQ worker (waits for in-flight jobs)...');
    await worker.close();
    // Step 3: quit ioredis. `quit()` sends QUIT and waits for server ack,
    // unlike `disconnect()` which rips the socket.
    log.info('Closing Redis connection...');
    try {
      await connection.quit();
    } catch (e) {
      // ioredis rejects quit() if the connection is already closed — not fatal.
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Redis quit raised (likely already closed)');
    }
    // Step 4: release MCP singleton. No network handle to close; this just
    // clears the process-global reference so GC can reclaim it.
    log.info('Releasing MCP client...');
    closeMcpClient();
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([drain.then(() => 'ok' as const), timeout]);
    if (result === 'timeout') {
      log.error({ timeoutMs }, 'Shutdown timed out — forcing exit(1)');
      return 1;
    }
    log.info('Graceful shutdown complete');
    return 0;
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'Shutdown failed — exit(1)');
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
/** Wire process-level error handlers and signal handlers. Exported for tests. */
export const installProcessHandlers = (handlers: {
  onShutdown: (signal: string) => Promise<void>;
  onFatal: (origin: string, err: unknown) => void;
  processRef?: NodeJS.Process;
}): void => {
  const proc = handlers.processRef ?? process;
  // H6 — without these, a detached promise throw (e.g. from onProgress) kills
  // the worker silently. We log + trigger shutdown + mark exit code 1.
  proc.on('uncaughtException', (err) => handlers.onFatal('uncaughtException', err));
  proc.on('unhandledRejection', (err) => handlers.onFatal('unhandledRejection', err));
  proc.on('SIGTERM', () => {
    void handlers.onShutdown('SIGTERM');
  });
  proc.on('SIGINT', () => {
    void handlers.onShutdown('SIGINT');
  });
};
// --- Bootstrap (skipped under test via NODE_ENV === 'test' or VITEST) ---
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' || !!process.env.VITEST;
if (!isTest) {
  const connection = createRedisConnection();
  // Spustit health server (default port 8090 dle konvence)
  const healthPort = parseInt(process.env.HEALTH_PORT || '8090', 10);
  const healthServer: Server = startHealthServer(healthPort, 'worker');
  const worker = new Worker<PdfJobData, PdfJobResult>(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
    limiter: { max: 10, duration: 60_000 },
    // M6: cap stored job records so Redis doesn't grow unbounded.
    removeOnComplete: REMOVE_ON_COMPLETE,
    removeOnFail: REMOVE_ON_FAIL,
  });
  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, sessionId: job.data.sessionId }, 'Job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, sessionId: job?.data.sessionId, err }, 'Job failed');
  });
  worker.on('error', (err) => {
    logger.error({ error: err.message }, 'Worker error');
  });
  logger.info({ concurrency: CONCURRENCY, queue: QUEUE_NAME, healthPort }, 'Worker started');
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    const code = await runShutdown({
      worker,
      connection,
      closeMcpClient: closeMcp,
      healthServer,
      log: logger,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(code);
  };
  const onFatal = (origin: string, err: unknown) => {
    logger.error(
      { origin, err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
      'Fatal error — initiating shutdown',
    );
    // Schedule shutdown; do not block the handler itself.
    void (async () => {
      const code = await runShutdown({
        worker,
        connection,
        closeMcpClient: closeMcp,
        healthServer,
        log: logger,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      // Any fatal always yields exit 1, even if shutdown itself was clean —
      // the originating error is the signal.
      process.exit(code === 0 ? 1 : code);
    })();
  };
  installProcessHandlers({ onShutdown: shutdown, onFatal });
}
```
### `spine/platform/security/privacy-gateway/index.ts`
```typescript
export * from './logic';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/helpers/index.ts`
```typescript
export { jsonSchemaOutputFormat } from './json-schema';
export { zodOutputFormat } from './zod';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export { Anthropic as default } from './client';
export { type Uploadable, toFile } from './core/uploads';
export { APIPromise } from './core/api-promise';
export { BaseAnthropic, Anthropic, type ClientOptions, HUMAN_PROMPT, AI_PROMPT } from './client';
export { PagePromise } from './core/pagination';
export {
  AnthropicError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  BadRequestError,
  AuthenticationError,
  InternalServerError,
  PermissionDeniedError,
  UnprocessableEntityError,
} from './core/error';
export type {
  AutoParseableOutputFormat,
  ParsedMessage,
  ParsedContentBlock,
  ParseableMessageCreateParams,
  ExtractParsedContentFromParams,
} from './lib/parser';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/internal/qs/index.ts`
```typescript
import { default_format, formatters, RFC1738, RFC3986 } from './formats';
const formats = {
  formatters,
  RFC1738,
  RFC3986,
  default: default_format,
};
export { stringify } from './stringify';
export { formats };
export type { DefaultDecoder, DefaultEncoder, Format, ParseOptions, StringifyOptions } from './types';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/agents/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Agents,
  type BetaManagedAgentsAgent,
  type BetaManagedAgentsAgentReference,
  type BetaManagedAgentsAgentToolConfig,
  type BetaManagedAgentsAgentToolConfigParams,
  type BetaManagedAgentsAgentToolsetDefaultConfig,
  type BetaManagedAgentsAgentToolsetDefaultConfigParams,
  type BetaManagedAgentsAgentToolset20260401,
  type BetaManagedAgentsAgentToolset20260401Params,
  type BetaManagedAgentsAlwaysAllowPolicy,
  type BetaManagedAgentsAlwaysAskPolicy,
  type BetaManagedAgentsAnthropicSkill,
  type BetaManagedAgentsAnthropicSkillParams,
  type BetaManagedAgentsCustomSkill,
  type BetaManagedAgentsCustomSkillParams,
  type BetaManagedAgentsCustomTool,
  type BetaManagedAgentsCustomToolInputSchema,
  type BetaManagedAgentsCustomToolParams,
  type BetaManagedAgentsMCPServerURLDefinition,
  type BetaManagedAgentsMCPToolConfig,
  type BetaManagedAgentsMCPToolConfigParams,
  type BetaManagedAgentsMCPToolset,
  type BetaManagedAgentsMCPToolsetDefaultConfig,
  type BetaManagedAgentsMCPToolsetDefaultConfigParams,
  type BetaManagedAgentsMCPToolsetParams,
  type BetaManagedAgentsModel,
  type BetaManagedAgentsModelConfig,
  type BetaManagedAgentsModelConfigParams,
  type BetaManagedAgentsMultiagentCoordinator,
  type BetaManagedAgentsMultiagentCoordinatorParams,
  type BetaManagedAgentsMultiagentSelfParams,
  type BetaManagedAgentsSkillParams,
  type BetaManagedAgentsURLMCPServerParams,
  type AgentCreateParams,
  type AgentRetrieveParams,
  type AgentUpdateParams,
  type AgentListParams,
  type AgentArchiveParams,
  type BetaManagedAgentsAgentsPageCursor,
} from './agents';
export { Versions, type VersionListParams } from './versions';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Agents,
  type BetaManagedAgentsAgent,
  type BetaManagedAgentsAgentReference,
  type BetaManagedAgentsAgentToolConfig,
  type BetaManagedAgentsAgentToolConfigParams,
  type BetaManagedAgentsAgentToolsetDefaultConfig,
  type BetaManagedAgentsAgentToolsetDefaultConfigParams,
  type BetaManagedAgentsAgentToolset20260401,
  type BetaManagedAgentsAgentToolset20260401Params,
  type BetaManagedAgentsAlwaysAllowPolicy,
  type BetaManagedAgentsAlwaysAskPolicy,
  type BetaManagedAgentsAnthropicSkill,
  type BetaManagedAgentsAnthropicSkillParams,
  type BetaManagedAgentsCustomSkill,
  type BetaManagedAgentsCustomSkillParams,
  type BetaManagedAgentsCustomTool,
  type BetaManagedAgentsCustomToolInputSchema,
  type BetaManagedAgentsCustomToolParams,
  type BetaManagedAgentsMCPServerURLDefinition,
  type BetaManagedAgentsMCPToolConfig,
  type BetaManagedAgentsMCPToolConfigParams,
  type BetaManagedAgentsMCPToolset,
  type BetaManagedAgentsMCPToolsetDefaultConfig,
  type BetaManagedAgentsMCPToolsetDefaultConfigParams,
  type BetaManagedAgentsMCPToolsetParams,
  type BetaManagedAgentsModel,
  type BetaManagedAgentsModelConfig,
  type BetaManagedAgentsModelConfigParams,
  type BetaManagedAgentsMultiagentCoordinator,
  type BetaManagedAgentsMultiagentCoordinatorParams,
  type BetaManagedAgentsMultiagentSelfParams,
  type BetaManagedAgentsSkillParams,
  type BetaManagedAgentsURLMCPServerParams,
  type AgentCreateParams,
  type AgentRetrieveParams,
  type AgentUpdateParams,
  type AgentListParams,
  type AgentArchiveParams,
  type BetaManagedAgentsAgentsPageCursor,
} from './agents/index';
export {
  Beta,
  type AnthropicBeta,
  type BetaAPIError,
  type BetaAuthenticationError,
  type BetaBillingError,
  type BetaError,
  type BetaErrorResponse,
  type BetaGatewayTimeoutError,
  type BetaInvalidRequestError,
  type BetaNotFoundError,
  type BetaOverloadedError,
  type BetaPermissionError,
  type BetaRateLimitError,
} from './beta';
export {
  Environments,
  type BetaCloudConfig,
  type BetaCloudConfigParams,
  type BetaEnvironment,
  type BetaEnvironmentDeleteResponse,
  type BetaLimitedNetwork,
  type BetaLimitedNetworkParams,
  type BetaPackages,
  type BetaPackagesParams,
  type BetaUnrestrictedNetwork,
  type EnvironmentCreateParams,
  type EnvironmentRetrieveParams,
  type EnvironmentUpdateParams,
  type EnvironmentListParams,
  type EnvironmentDeleteParams,
  type EnvironmentArchiveParams,
  type BetaEnvironmentsPageCursor,
} from './environments';
export {
  Files,
  type BetaFileScope,
  type DeletedFile,
  type FileMetadata,
  type FileListParams,
  type FileDeleteParams,
  type FileDownloadParams,
  type FileRetrieveMetadataParams,
  type FileUploadParams,
  type FileMetadataPage,
} from './files';
export {
  MemoryStores,
  type BetaManagedAgentsDeletedMemoryStore,
  type BetaManagedAgentsMemoryStore,
  type MemoryStoreCreateParams,
  type MemoryStoreRetrieveParams,
  type MemoryStoreUpdateParams,
  type MemoryStoreListParams,
  type MemoryStoreDeleteParams,
  type MemoryStoreArchiveParams,
  type BetaManagedAgentsMemoryStoresPageCursor,
} from './memory-stores/index';
export {
  Messages,
  type BetaAdvisorMessageIterationUsage,
  type BetaAdvisorRedactedResultBlock,
  type BetaAdvisorRedactedResultBlockParam,
  type BetaAdvisorResultBlock,
  type BetaAdvisorResultBlockParam,
  type BetaAdvisorTool20260301,
  type BetaAdvisorToolResultBlock,
  type BetaAdvisorToolResultBlockParam,
  type BetaAdvisorToolResultError,
  type BetaAdvisorToolResultErrorParam,
  type BetaAllThinkingTurns,
  type BetaBase64ImageSource,
  type BetaBase64PDFSource,
  type BetaBashCodeExecutionOutputBlock,
  type BetaBashCodeExecutionOutputBlockParam,
  type BetaBashCodeExecutionResultBlock,
  type BetaBashCodeExecutionResultBlockParam,
  type BetaBashCodeExecutionToolResultBlock,
  type BetaBashCodeExecutionToolResultBlockParam,
  type BetaBashCodeExecutionToolResultError,
  type BetaBashCodeExecutionToolResultErrorParam,
  type BetaCacheControlEphemeral,
  type BetaCacheCreation,
  type BetaCitationCharLocation,
  type BetaCitationCharLocationParam,
  type BetaCitationConfig,
  type BetaCitationContentBlockLocation,
  type BetaCitationContentBlockLocationParam,
  type BetaCitationPageLocation,
  type BetaCitationPageLocationParam,
  type BetaCitationSearchResultLocation,
  type BetaCitationSearchResultLocationParam,
  type BetaCitationWebSearchResultLocationParam,
  type BetaCitationsConfigParam,
  type BetaCitationsDelta,
  type BetaCitationsWebSearchResultLocation,
  type BetaClearThinking20251015Edit,
  type BetaClearThinking20251015EditResponse,
  type BetaClearToolUses20250919Edit,
  type BetaClearToolUses20250919EditResponse,
  type BetaCodeExecutionOutputBlock,
  type BetaCodeExecutionOutputBlockParam,
  type BetaCodeExecutionResultBlock,
  type BetaCodeExecutionResultBlockParam,
  type BetaCodeExecutionTool20250522,
  type BetaCodeExecutionTool20250825,
  type BetaCodeExecutionTool20260120,
  type BetaCodeExecutionToolResultBlock,
  type BetaCodeExecutionToolResultBlockContent,
  type BetaCodeExecutionToolResultBlockParam,
  type BetaCodeExecutionToolResultBlockParamContent,
  type BetaCodeExecutionToolResultError,
  type BetaCodeExecutionToolResultErrorCode,
  type BetaCodeExecutionToolResultErrorParam,
  type BetaCompact20260112Edit,
  type BetaCompactionBlock,
  type BetaCompactionBlockParam,
  type BetaCompactionContentBlockDelta,
  type BetaCompactionIterationUsage,
  type BetaContainer,
  type BetaContainerParams,
  type BetaContainerUploadBlock,
  type BetaContainerUploadBlockParam,
  type BetaContentBlock,
  type BetaContentBlockParam,
  type BetaContentBlockSource,
  type BetaContentBlockSourceContent,
  type BetaContextManagementConfig,
  type BetaContextManagementResponse,
  type BetaCountTokensContextManagementResponse,
  type BetaDirectCaller,
  type BetaDocumentBlock,
  type BetaEncryptedCodeExecutionResultBlock,
  type BetaEncryptedCodeExecutionResultBlockParam,
  type BetaFileDocumentSource,
  type BetaFileImageSource,
  type BetaImageBlockParam,
  type BetaInputJSONDelta,
  type BetaInputTokensClearAtLeast,
  type BetaInputTokensTrigger,
  type BetaIterationsUsage,
  type BetaJSONOutputFormat,
  type BetaMCPToolConfig,
  type BetaMCPToolDefaultConfig,
  type BetaMCPToolResultBlock,
  type BetaMCPToolUseBlock,
  type BetaMCPToolUseBlockParam,
  type BetaMCPToolset,
  type BetaMemoryTool20250818,
  type BetaMemoryTool20250818Command,
  type BetaMemoryTool20250818CreateCommand,
  type BetaMemoryTool20250818DeleteCommand,
  type BetaMemoryTool20250818InsertCommand,
  type BetaMemoryTool20250818RenameCommand,
  type BetaMemoryTool20250818StrReplaceCommand,
  type BetaMemoryTool20250818ViewCommand,
  type BetaMessage,
  type BetaMessageDeltaUsage,
  type BetaMessageIterationUsage,
  type BetaMessageParam,
  type BetaMessageTokensCount,
  type BetaMetadata,
  type BetaOutputConfig,
  type BetaPlainTextSource,
  type BetaRawContentBlockDelta,
  type BetaRawContentBlockDeltaEvent,
  type BetaRawContentBlockStartEvent,
  type BetaRawContentBlockStopEvent,
  type BetaRawMessageDeltaEvent,
  type BetaRawMessageStartEvent,
  type BetaRawMessageStopEvent,
  type BetaRawMessageStreamEvent,
  type BetaRedactedThinkingBlock,
  type BetaRedactedThinkingBlockParam,
  type BetaRefusalStopDetails,
  type BetaRequestDocumentBlock,
  type BetaRequestMCPServerToolConfiguration,
  type BetaRequestMCPServerURLDefinition,
  type BetaRequestMCPToolResultBlockParam,
  type BetaSearchResultBlockParam,
  type BetaServerToolCaller,
  type BetaServerToolCaller20260120,
  type BetaServerToolUsage,
  type BetaServerToolUseBlock,
  type BetaServerToolUseBlockParam,
  type BetaSignatureDelta,
  type BetaSkill,
  type BetaSkillParams,
  type BetaStopReason,
  type BetaTextBlock,
  type BetaTextBlockParam,
  type BetaTextCitation,
  type BetaTextCitationParam,
  type BetaTextDelta,
  type BetaTextEditorCodeExecutionCreateResultBlock,
  type BetaTextEditorCodeExecutionCreateResultBlockParam,
  type BetaTextEditorCodeExecutionStrReplaceResultBlock,
  type BetaTextEditorCodeExecutionStrReplaceResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultBlock,
  type BetaTextEditorCodeExecutionToolResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultError,
  type BetaTextEditorCodeExecutionToolResultErrorParam,
  type BetaTextEditorCodeExecutionViewResultBlock,
  type BetaTextEditorCodeExecutionViewResultBlockParam,
  type BetaThinkingBlock,
  type BetaThinkingBlockParam,
  type BetaThinkingConfigAdaptive,
  type BetaThinkingConfigDisabled,
  type BetaThinkingConfigEnabled,
  type BetaThinkingConfigParam,
  type BetaThinkingDelta,
  type BetaThinkingTurns,
  type BetaTokenTaskBudget,
  type BetaTool,
  type BetaToolBash20241022,
  type BetaToolBash20250124,
  type BetaToolChoice,
  type BetaToolChoiceAny,
  type BetaToolChoiceAuto,
  type BetaToolChoiceNone,
  type BetaToolChoiceTool,
  type BetaToolComputerUse20241022,
  type BetaToolComputerUse20250124,
  type BetaToolComputerUse20251124,
  type BetaToolReferenceBlock,
  type BetaToolReferenceBlockParam,
  type BetaToolResultBlockParam,
  type BetaToolSearchToolBm25_20251119,
  type BetaToolSearchToolRegex20251119,
  type BetaToolSearchToolResultBlock,
  type BetaToolSearchToolResultBlockParam,
  type BetaToolSearchToolResultError,
  type BetaToolSearchToolResultErrorParam,
  type BetaToolSearchToolSearchResultBlock,
  type BetaToolSearchToolSearchResultBlockParam,
  type BetaToolTextEditor20241022,
  type BetaToolTextEditor20250124,
  type BetaToolTextEditor20250429,
  type BetaToolTextEditor20250728,
  type BetaToolUnion,
  type BetaToolUseBlock,
  type BetaToolUseBlockParam,
  type BetaToolUsesKeep,
  type BetaToolUsesTrigger,
  type BetaURLImageSource,
  type BetaURLPDFSource,
  type BetaUsage,
  type BetaUserLocation,
  type BetaWebFetchBlock,
  type BetaWebFetchBlockParam,
  type BetaWebFetchTool20250910,
  type BetaWebFetchTool20260209,
  type BetaWebFetchTool20260309,
  type BetaWebFetchToolResultBlock,
  type BetaWebFetchToolResultBlockParam,
  type BetaWebFetchToolResultErrorBlock,
  type BetaWebFetchToolResultErrorBlockParam,
  type BetaWebFetchToolResultErrorCode,
  type BetaWebSearchResultBlock,
  type BetaWebSearchResultBlockParam,
  type BetaWebSearchTool20250305,
  type BetaWebSearchTool20260209,
  type BetaWebSearchToolRequestError,
  type BetaWebSearchToolResultBlock,
  type BetaWebSearchToolResultBlockContent,
  type BetaWebSearchToolResultBlockParam,
  type BetaWebSearchToolResultBlockParamContent,
  type BetaWebSearchToolResultError,
  type BetaWebSearchToolResultErrorCode,
  type BetaBase64PDFBlock,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
  type BetaToolResultContentBlockParam,
} from './messages/index';
export {
  Models,
  type BetaCapabilitySupport,
  type BetaContextManagementCapability,
  type BetaEffortCapability,
  type BetaModelCapabilities,
  type BetaModelInfo,
  type BetaThinkingCapability,
  type BetaThinkingTypes,
  type ModelRetrieveParams,
  type ModelListParams,
  type BetaModelInfosPage,
} from './models';
export {
  Sessions,
  type BetaManagedAgentsAgentParams,
  type BetaManagedAgentsBranchCheckout,
  type BetaManagedAgentsCacheCreationUsage,
  type BetaManagedAgentsCommitCheckout,
  type BetaManagedAgentsDeletedSession,
  type BetaManagedAgentsFileResourceParams,
  type BetaManagedAgentsGitHubRepositoryResourceParams,
  type BetaManagedAgentsMemoryStoreResourceParam,
  type BetaManagedAgentsMultiagent,
  type BetaManagedAgentsMultiagentParams,
  type BetaManagedAgentsMultiagentRosterEntryParams,
  type BetaManagedAgentsOutcomeEvaluationResource,
  type BetaManagedAgentsSession,
  type BetaManagedAgentsSessionAgent,
  type BetaManagedAgentsSessionMultiagentCoordinator,
  type BetaManagedAgentsSessionStats,
  type BetaManagedAgentsSessionUsage,
  type SessionCreateParams,
  type SessionRetrieveParams,
  type SessionUpdateParams,
  type SessionListParams,
  type SessionDeleteParams,
  type SessionArchiveParams,
  type BetaManagedAgentsSessionsPageCursor,
} from './sessions/index';
export {
  Skills,
  type SkillCreateResponse,
  type SkillRetrieveResponse,
  type SkillListResponse,
  type SkillDeleteResponse,
  type SkillCreateParams,
  type SkillRetrieveParams,
  type SkillListParams,
  type SkillDeleteParams,
  type SkillListResponsesPageCursor,
} from './skills/index';
export {
  UserProfiles,
  type BetaUserProfile,
  type BetaUserProfileEnrollmentURL,
  type BetaUserProfileTrustGrant,
  type UserProfileCreateParams,
  type UserProfileRetrieveParams,
  type UserProfileUpdateParams,
  type UserProfileListParams,
  type UserProfileCreateEnrollmentURLParams,
  type BetaUserProfilesPageCursor,
} from './user-profiles';
export {
  Vaults,
  type BetaManagedAgentsDeletedVault,
  type BetaManagedAgentsVault,
  type VaultCreateParams,
  type VaultRetrieveParams,
  type VaultUpdateParams,
  type VaultListParams,
  type VaultDeleteParams,
  type VaultArchiveParams,
  type BetaManagedAgentsVaultsPageCursor,
} from './vaults/index';
export {
  Webhooks,
  type BetaWebhookEvent,
  type BetaWebhookEventData,
  type BetaWebhookSessionArchivedEventData,
  type BetaWebhookSessionCreatedEventData,
  type BetaWebhookSessionDeletedEventData,
  type BetaWebhookSessionIdledEventData,
  type BetaWebhookSessionOutcomeEvaluationEndedEventData,
  type BetaWebhookSessionPendingEventData,
  type BetaWebhookSessionRequiresActionEventData,
  type BetaWebhookSessionRunningEventData,
  type BetaWebhookSessionStatusIdledEventData,
  type BetaWebhookSessionStatusRescheduledEventData,
  type BetaWebhookSessionStatusRunStartedEventData,
  type BetaWebhookSessionStatusTerminatedEventData,
  type BetaWebhookSessionThreadCreatedEventData,
  type BetaWebhookSessionThreadIdledEventData,
  type BetaWebhookSessionThreadTerminatedEventData,
  type BetaWebhookVaultArchivedEventData,
  type BetaWebhookVaultCreatedEventData,
  type BetaWebhookVaultCredentialArchivedEventData,
  type BetaWebhookVaultCredentialCreatedEventData,
  type BetaWebhookVaultCredentialDeletedEventData,
  type BetaWebhookVaultCredentialRefreshFailedEventData,
  type BetaWebhookVaultDeletedEventData,
  type UnwrapWebhookEvent,
} from './webhooks';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/memory-stores/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Memories,
  type BetaManagedAgentsConflictError,
  type BetaManagedAgentsContentSha256Precondition,
  type BetaManagedAgentsDeletedMemory,
  type BetaManagedAgentsError,
  type BetaManagedAgentsMemory,
  type BetaManagedAgentsMemoryListItem,
  type BetaManagedAgentsMemoryPathConflictError,
  type BetaManagedAgentsMemoryPreconditionFailedError,
  type BetaManagedAgentsMemoryPrefix,
  type BetaManagedAgentsMemoryView,
  type BetaManagedAgentsPrecondition,
  type MemoryCreateParams,
  type MemoryRetrieveParams,
  type MemoryUpdateParams,
  type MemoryListParams,
  type MemoryDeleteParams,
  type BetaManagedAgentsMemoryListItemsPageCursor,
} from './memories';
export {
  MemoryStores,
  type BetaManagedAgentsDeletedMemoryStore,
  type BetaManagedAgentsMemoryStore,
  type MemoryStoreCreateParams,
  type MemoryStoreRetrieveParams,
  type MemoryStoreUpdateParams,
  type MemoryStoreListParams,
  type MemoryStoreDeleteParams,
  type MemoryStoreArchiveParams,
  type BetaManagedAgentsMemoryStoresPageCursor,
} from './memory-stores';
export {
  MemoryVersions,
  type BetaManagedAgentsActor,
  type BetaManagedAgentsAPIActor,
  type BetaManagedAgentsMemoryVersion,
  type BetaManagedAgentsMemoryVersionOperation,
  type BetaManagedAgentsSessionActor,
  type BetaManagedAgentsUserActor,
  type MemoryVersionRetrieveParams,
  type MemoryVersionListParams,
  type MemoryVersionRedactParams,
  type BetaManagedAgentsMemoryVersionsPageCursor,
} from './memory-versions';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/messages/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Batches,
  type BetaDeletedMessageBatch,
  type BetaMessageBatch,
  type BetaMessageBatchCanceledResult,
  type BetaMessageBatchErroredResult,
  type BetaMessageBatchExpiredResult,
  type BetaMessageBatchIndividualResponse,
  type BetaMessageBatchRequestCounts,
  type BetaMessageBatchResult,
  type BetaMessageBatchSucceededResult,
  type BatchCreateParams,
  type BatchRetrieveParams,
  type BatchListParams,
  type BatchDeleteParams,
  type BatchCancelParams,
  type BatchResultsParams,
  type BetaMessageBatchesPage,
} from './batches';
export {
  Messages,
  type BetaAdvisorMessageIterationUsage,
  type BetaAdvisorRedactedResultBlock,
  type BetaAdvisorRedactedResultBlockParam,
  type BetaAdvisorResultBlock,
  type BetaAdvisorResultBlockParam,
  type BetaAdvisorTool20260301,
  type BetaAdvisorToolResultBlock,
  type BetaAdvisorToolResultBlockParam,
  type BetaAdvisorToolResultError,
  type BetaAdvisorToolResultErrorParam,
  type BetaAllThinkingTurns,
  type BetaBase64ImageSource,
  type BetaBase64PDFSource,
  type BetaBashCodeExecutionOutputBlock,
  type BetaBashCodeExecutionOutputBlockParam,
  type BetaBashCodeExecutionResultBlock,
  type BetaBashCodeExecutionResultBlockParam,
  type BetaBashCodeExecutionToolResultBlock,
  type BetaBashCodeExecutionToolResultBlockParam,
  type BetaBashCodeExecutionToolResultError,
  type BetaBashCodeExecutionToolResultErrorParam,
  type BetaCacheControlEphemeral,
  type BetaCacheCreation,
  type BetaCitationCharLocation,
  type BetaCitationCharLocationParam,
  type BetaCitationConfig,
  type BetaCitationContentBlockLocation,
  type BetaCitationContentBlockLocationParam,
  type BetaCitationPageLocation,
  type BetaCitationPageLocationParam,
  type BetaCitationSearchResultLocation,
  type BetaCitationSearchResultLocationParam,
  type BetaCitationWebSearchResultLocationParam,
  type BetaCitationsConfigParam,
  type BetaCitationsDelta,
  type BetaCitationsWebSearchResultLocation,
  type BetaClearThinking20251015Edit,
  type BetaClearThinking20251015EditResponse,
  type BetaClearToolUses20250919Edit,
  type BetaClearToolUses20250919EditResponse,
  type BetaCodeExecutionOutputBlock,
  type BetaCodeExecutionOutputBlockParam,
  type BetaCodeExecutionResultBlock,
  type BetaCodeExecutionResultBlockParam,
  type BetaCodeExecutionTool20250522,
  type BetaCodeExecutionTool20250825,
  type BetaCodeExecutionTool20260120,
  type BetaCodeExecutionToolResultBlock,
  type BetaCodeExecutionToolResultBlockContent,
  type BetaCodeExecutionToolResultBlockParam,
  type BetaCodeExecutionToolResultBlockParamContent,
  type BetaCodeExecutionToolResultError,
  type BetaCodeExecutionToolResultErrorCode,
  type BetaCodeExecutionToolResultErrorParam,
  type BetaCompact20260112Edit,
  type BetaCompactionBlock,
  type BetaCompactionBlockParam,
  type BetaCompactionContentBlockDelta,
  type BetaCompactionIterationUsage,
  type BetaContainer,
  type BetaContainerParams,
  type BetaContainerUploadBlock,
  type BetaContainerUploadBlockParam,
  type BetaContentBlock,
  type BetaContentBlockParam,
  type BetaContentBlockSource,
  type BetaContentBlockSourceContent,
  type BetaContextManagementConfig,
  type BetaContextManagementResponse,
  type BetaCountTokensContextManagementResponse,
  type BetaDirectCaller,
  type BetaDocumentBlock,
  type BetaEncryptedCodeExecutionResultBlock,
  type BetaEncryptedCodeExecutionResultBlockParam,
  type BetaFileDocumentSource,
  type BetaFileImageSource,
  type BetaImageBlockParam,
  type BetaInputJSONDelta,
  type BetaInputTokensClearAtLeast,
  type BetaInputTokensTrigger,
  type BetaIterationsUsage,
  type BetaJSONOutputFormat,
  type BetaMCPToolResultBlock,
  type BetaMCPToolUseBlock,
  type BetaMCPToolUseBlockParam,
  type BetaMCPToolset,
  type BetaMemoryTool20250818,
  type BetaMemoryTool20250818Command,
  type BetaMemoryTool20250818CreateCommand,
  type BetaMemoryTool20250818DeleteCommand,
  type BetaMemoryTool20250818InsertCommand,
  type BetaMemoryTool20250818RenameCommand,
  type BetaMemoryTool20250818StrReplaceCommand,
  type BetaMemoryTool20250818ViewCommand,
  type BetaMessage,
  type BetaMessageDeltaUsage,
  type BetaMessageIterationUsage,
  type BetaMessageParam,
  type BetaMessageTokensCount,
  type BetaMetadata,
  type BetaOutputConfig,
  type BetaPlainTextSource,
  type BetaRawContentBlockDelta,
  type BetaRawContentBlockDeltaEvent,
  type BetaRawContentBlockStartEvent,
  type BetaRawContentBlockStopEvent,
  type BetaRawMessageDeltaEvent,
  type BetaRawMessageStartEvent,
  type BetaRawMessageStopEvent,
  type BetaRawMessageStreamEvent,
  type BetaRedactedThinkingBlock,
  type BetaRedactedThinkingBlockParam,
  type BetaRefusalStopDetails,
  type BetaRequestDocumentBlock,
  type BetaRequestMCPServerToolConfiguration,
  type BetaRequestMCPServerURLDefinition,
  type BetaRequestMCPToolResultBlockParam,
  type BetaSearchResultBlockParam,
  type BetaServerToolCaller,
  type BetaServerToolCaller20260120,
  type BetaServerToolUsage,
  type BetaServerToolUseBlock,
  type BetaServerToolUseBlockParam,
  type BetaSignatureDelta,
  type BetaSkill,
  type BetaSkillParams,
  type BetaStopReason,
  type BetaTextBlock,
  type BetaTextBlockParam,
  type BetaTextCitation,
  type BetaTextCitationParam,
  type BetaTextDelta,
  type BetaTextEditorCodeExecutionCreateResultBlock,
  type BetaTextEditorCodeExecutionCreateResultBlockParam,
  type BetaTextEditorCodeExecutionStrReplaceResultBlock,
  type BetaTextEditorCodeExecutionStrReplaceResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultBlock,
  type BetaTextEditorCodeExecutionToolResultBlockParam,
  type BetaTextEditorCodeExecutionToolResultError,
  type BetaTextEditorCodeExecutionToolResultErrorParam,
  type BetaTextEditorCodeExecutionViewResultBlock,
  type BetaTextEditorCodeExecutionViewResultBlockParam,
  type BetaThinkingBlock,
  type BetaThinkingBlockParam,
  type BetaThinkingConfigAdaptive,
  type BetaThinkingConfigDisabled,
  type BetaThinkingConfigEnabled,
  type BetaThinkingConfigParam,
  type BetaThinkingDelta,
  type BetaThinkingTurns,
  type BetaTokenTaskBudget,
  type BetaTool,
  type BetaToolBash20241022,
  type BetaToolBash20250124,
  type BetaToolChoice,
  type BetaToolChoiceAny,
  type BetaToolChoiceAuto,
  type BetaToolChoiceNone,
  type BetaToolChoiceTool,
  type BetaToolComputerUse20241022,
  type BetaToolComputerUse20250124,
  type BetaToolComputerUse20251124,
  type BetaToolReferenceBlock,
  type BetaToolReferenceBlockParam,
  type BetaToolResultBlockParam,
  type BetaToolTextEditor20241022,
  type BetaToolTextEditor20250124,
  type BetaToolTextEditor20250429,
  type BetaToolTextEditor20250728,
  type BetaToolUnion,
  type BetaToolUseBlock,
  type BetaToolUseBlockParam,
  type BetaToolUsesKeep,
  type BetaToolUsesTrigger,
  type BetaURLImageSource,
  type BetaURLPDFSource,
  type BetaUsage,
  type BetaUserLocation,
  type BetaWebFetchBlock,
  type BetaWebFetchBlockParam,
  type BetaWebFetchTool20250910,
  type BetaWebFetchTool20260209,
  type BetaWebFetchTool20260309,
  type BetaWebFetchToolResultBlock,
  type BetaWebFetchToolResultBlockParam,
  type BetaWebFetchToolResultErrorBlock,
  type BetaWebFetchToolResultErrorBlockParam,
  type BetaWebFetchToolResultErrorCode,
  type BetaWebSearchResultBlock,
  type BetaWebSearchResultBlockParam,
  type BetaWebSearchTool20250305,
  type BetaWebSearchTool20260209,
  type BetaWebSearchToolRequestError,
  type BetaWebSearchToolResultBlock,
  type BetaWebSearchToolResultBlockContent,
  type BetaWebSearchToolResultBlockParam,
  type BetaWebSearchToolResultBlockParamContent,
  type BetaWebSearchToolResultError,
  type BetaWebSearchToolResultErrorCode,
  type BetaBase64PDFBlock,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
  type BetaMessageStreamParams,
  type BetaToolSearchToolBm25_20251119,
  type BetaToolSearchToolRegex20251119,
  type BetaToolSearchToolResultBlock,
  type BetaToolSearchToolResultBlockParam,
  type BetaToolSearchToolResultError,
  type BetaToolSearchToolResultErrorParam,
  type BetaToolSearchToolSearchResultBlock,
  type BetaToolSearchToolSearchResultBlockParam,
  type BetaMCPToolConfig,
  type BetaMCPToolDefaultConfig,
  type BetaToolResultContentBlockParam,
} from './messages';
export { BetaToolRunner, type BetaToolRunnerParams, ToolError } from './messages';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/sessions/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Events,
  type BetaManagedAgentsAgentCustomToolUseEvent,
  type BetaManagedAgentsAgentMCPToolResultEvent,
  type BetaManagedAgentsAgentMCPToolUseEvent,
  type BetaManagedAgentsAgentMessageEvent,
  type BetaManagedAgentsAgentThinkingEvent,
  type BetaManagedAgentsAgentThreadContextCompactedEvent,
  type BetaManagedAgentsAgentThreadMessageReceivedEvent,
  type BetaManagedAgentsAgentThreadMessageSentEvent,
  type BetaManagedAgentsAgentToolResultEvent,
  type BetaManagedAgentsAgentToolUseEvent,
  type BetaManagedAgentsBase64DocumentSource,
  type BetaManagedAgentsBase64ImageSource,
  type BetaManagedAgentsBillingError,
  type BetaManagedAgentsDocumentBlock,
  type BetaManagedAgentsEventParams,
  type BetaManagedAgentsFileDocumentSource,
  type BetaManagedAgentsFileImageSource,
  type BetaManagedAgentsFileRubric,
  type BetaManagedAgentsFileRubricParams,
  type BetaManagedAgentsImageBlock,
  type BetaManagedAgentsMCPAuthenticationFailedError,
  type BetaManagedAgentsMCPConnectionFailedError,
  type BetaManagedAgentsModelOverloadedError,
  type BetaManagedAgentsModelRateLimitedError,
  type BetaManagedAgentsModelRequestFailedError,
  type BetaManagedAgentsPlainTextDocumentSource,
  type BetaManagedAgentsRetryStatusExhausted,
  type BetaManagedAgentsRetryStatusRetrying,
  type BetaManagedAgentsRetryStatusTerminal,
  type BetaManagedAgentsSendSessionEvents,
  type BetaManagedAgentsSessionDeletedEvent,
  type BetaManagedAgentsSessionEndTurn,
  type BetaManagedAgentsSessionErrorEvent,
  type BetaManagedAgentsSessionEvent,
  type BetaManagedAgentsSessionRequiresAction,
  type BetaManagedAgentsSessionRetriesExhausted,
  type BetaManagedAgentsSessionStatusIdleEvent,
  type BetaManagedAgentsSessionStatusRescheduledEvent,
  type BetaManagedAgentsSessionStatusRunningEvent,
  type BetaManagedAgentsSessionStatusTerminatedEvent,
  type BetaManagedAgentsSessionThreadCreatedEvent,
  type BetaManagedAgentsSessionThreadStatusIdleEvent,
  type BetaManagedAgentsSessionThreadStatusRescheduledEvent,
  type BetaManagedAgentsSessionThreadStatusRunningEvent,
  type BetaManagedAgentsSessionThreadStatusTerminatedEvent,
  type BetaManagedAgentsSpanModelRequestEndEvent,
  type BetaManagedAgentsSpanModelRequestStartEvent,
  type BetaManagedAgentsSpanModelUsage,
  type BetaManagedAgentsSpanOutcomeEvaluationEndEvent,
  type BetaManagedAgentsSpanOutcomeEvaluationOngoingEvent,
  type BetaManagedAgentsSpanOutcomeEvaluationStartEvent,
  type BetaManagedAgentsStreamSessionEvents,
  type BetaManagedAgentsTextBlock,
  type BetaManagedAgentsTextRubric,
  type BetaManagedAgentsTextRubricParams,
  type BetaManagedAgentsUnknownError,
  type BetaManagedAgentsURLDocumentSource,
  type BetaManagedAgentsURLImageSource,
  type BetaManagedAgentsUserCustomToolResultEvent,
  type BetaManagedAgentsUserCustomToolResultEventParams,
  type BetaManagedAgentsUserDefineOutcomeEvent,
  type BetaManagedAgentsUserDefineOutcomeEventParams,
  type BetaManagedAgentsUserInterruptEvent,
  type BetaManagedAgentsUserInterruptEventParams,
  type BetaManagedAgentsUserMessageEvent,
  type BetaManagedAgentsUserMessageEventParams,
  type BetaManagedAgentsUserToolConfirmationEvent,
  type BetaManagedAgentsUserToolConfirmationEventParams,
  type EventListParams,
  type EventSendParams,
  type EventStreamParams,
  type BetaManagedAgentsSessionEventsPageCursor,
} from './events';
export {
  Resources,
  type BetaManagedAgentsDeleteSessionResource,
  type BetaManagedAgentsFileResource,
  type BetaManagedAgentsGitHubRepositoryResource,
  type BetaManagedAgentsMemoryStoreResource,
  type BetaManagedAgentsSessionResource,
  type ResourceRetrieveResponse,
  type ResourceUpdateResponse,
  type ResourceRetrieveParams,
  type ResourceUpdateParams,
  type ResourceListParams,
  type ResourceDeleteParams,
  type ResourceAddParams,
  type BetaManagedAgentsSessionResourcesPageCursor,
} from './resources';
export {
  Sessions,
  type BetaManagedAgentsAgentParams,
  type BetaManagedAgentsBranchCheckout,
  type BetaManagedAgentsCacheCreationUsage,
  type BetaManagedAgentsCommitCheckout,
  type BetaManagedAgentsDeletedSession,
  type BetaManagedAgentsFileResourceParams,
  type BetaManagedAgentsGitHubRepositoryResourceParams,
  type BetaManagedAgentsMemoryStoreResourceParam,
  type BetaManagedAgentsMultiagent,
  type BetaManagedAgentsMultiagentParams,
  type BetaManagedAgentsMultiagentRosterEntryParams,
  type BetaManagedAgentsOutcomeEvaluationResource,
  type BetaManagedAgentsSession,
  type BetaManagedAgentsSessionAgent,
  type BetaManagedAgentsSessionMultiagentCoordinator,
  type BetaManagedAgentsSessionStats,
  type BetaManagedAgentsSessionUsage,
  type SessionCreateParams,
  type SessionRetrieveParams,
  type SessionUpdateParams,
  type SessionListParams,
  type SessionDeleteParams,
  type SessionArchiveParams,
  type BetaManagedAgentsSessionsPageCursor,
} from './sessions';
export {
  Threads,
  type BetaManagedAgentsSessionThread,
  type BetaManagedAgentsSessionThreadAgent,
  type BetaManagedAgentsSessionThreadStats,
  type BetaManagedAgentsSessionThreadStatus,
  type BetaManagedAgentsSessionThreadUsage,
  type BetaManagedAgentsStreamSessionThreadEvents,
  type ThreadRetrieveParams,
  type ThreadListParams,
  type ThreadArchiveParams,
  type BetaManagedAgentsSessionThreadsPageCursor,
} from './threads/index';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/sessions/threads/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export { Events, type EventListParams, type EventStreamParams } from './events';
export {
  Threads,
  type BetaManagedAgentsSessionThread,
  type BetaManagedAgentsSessionThreadAgent,
  type BetaManagedAgentsSessionThreadStats,
  type BetaManagedAgentsSessionThreadStatus,
  type BetaManagedAgentsSessionThreadUsage,
  type BetaManagedAgentsStreamSessionThreadEvents,
  type ThreadRetrieveParams,
  type ThreadListParams,
  type ThreadArchiveParams,
  type BetaManagedAgentsSessionThreadsPageCursor,
} from './threads';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/skills/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Skills,
  type SkillCreateResponse,
  type SkillRetrieveResponse,
  type SkillListResponse,
  type SkillDeleteResponse,
  type SkillCreateParams,
  type SkillRetrieveParams,
  type SkillListParams,
  type SkillDeleteParams,
  type SkillListResponsesPageCursor,
} from './skills';
export {
  Versions,
  type VersionCreateResponse,
  type VersionRetrieveResponse,
  type VersionListResponse,
  type VersionDeleteResponse,
  type VersionCreateParams,
  type VersionRetrieveParams,
  type VersionListParams,
  type VersionDeleteParams,
  type VersionListResponsesPageCursor,
} from './versions';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/beta/vaults/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Credentials,
  type BetaManagedAgentsCredential,
  type BetaManagedAgentsCredentialValidation,
  type BetaManagedAgentsCredentialValidationStatus,
  type BetaManagedAgentsDeletedCredential,
  type BetaManagedAgentsMCPOAuthAuthResponse,
  type BetaManagedAgentsMCPOAuthCreateParams,
  type BetaManagedAgentsMCPOAuthRefreshParams,
  type BetaManagedAgentsMCPOAuthRefreshResponse,
  type BetaManagedAgentsMCPOAuthRefreshUpdateParams,
  type BetaManagedAgentsMCPOAuthUpdateParams,
  type BetaManagedAgentsMCPProbe,
  type BetaManagedAgentsRefreshHTTPResponse,
  type BetaManagedAgentsRefreshObject,
  type BetaManagedAgentsStaticBearerAuthResponse,
  type BetaManagedAgentsStaticBearerCreateParams,
  type BetaManagedAgentsStaticBearerUpdateParams,
  type BetaManagedAgentsTokenEndpointAuthBasicParam,
  type BetaManagedAgentsTokenEndpointAuthBasicResponse,
  type BetaManagedAgentsTokenEndpointAuthBasicUpdateParam,
  type BetaManagedAgentsTokenEndpointAuthNoneParam,
  type BetaManagedAgentsTokenEndpointAuthNoneResponse,
  type BetaManagedAgentsTokenEndpointAuthPostParam,
  type BetaManagedAgentsTokenEndpointAuthPostResponse,
  type BetaManagedAgentsTokenEndpointAuthPostUpdateParam,
  type CredentialCreateParams,
  type CredentialRetrieveParams,
  type CredentialUpdateParams,
  type CredentialListParams,
  type CredentialDeleteParams,
  type CredentialArchiveParams,
  type CredentialMCPOAuthValidateParams,
  type BetaManagedAgentsCredentialsPageCursor,
} from './credentials';
export {
  Vaults,
  type BetaManagedAgentsDeletedVault,
  type BetaManagedAgentsVault,
  type VaultCreateParams,
  type VaultRetrieveParams,
  type VaultUpdateParams,
  type VaultListParams,
  type VaultDeleteParams,
  type VaultArchiveParams,
  type BetaManagedAgentsVaultsPageCursor,
} from './vaults';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export * from './shared';
export {
  Beta,
  type AnthropicBeta,
  type BetaAPIError,
  type BetaAuthenticationError,
  type BetaBillingError,
  type BetaError,
  type BetaErrorResponse,
  type BetaGatewayTimeoutError,
  type BetaInvalidRequestError,
  type BetaNotFoundError,
  type BetaOverloadedError,
  type BetaPermissionError,
  type BetaRateLimitError,
} from './beta/beta';
export {
  Completions,
  type Completion,
  type CompletionCreateParams,
  type CompletionCreateParamsNonStreaming,
  type CompletionCreateParamsStreaming,
} from './completions';
export {
  Messages,
  type Base64ImageSource,
  type Base64PDFSource,
  type BashCodeExecutionOutputBlock,
  type BashCodeExecutionOutputBlockParam,
  type BashCodeExecutionResultBlock,
  type BashCodeExecutionResultBlockParam,
  type BashCodeExecutionToolResultBlock,
  type BashCodeExecutionToolResultBlockParam,
  type BashCodeExecutionToolResultError,
  type BashCodeExecutionToolResultErrorCode,
  type BashCodeExecutionToolResultErrorParam,
  type CacheControlEphemeral,
  type CacheCreation,
  type CitationCharLocation,
  type CitationCharLocationParam,
  type CitationContentBlockLocation,
  type CitationContentBlockLocationParam,
  type CitationPageLocation,
  type CitationPageLocationParam,
  type CitationSearchResultLocationParam,
  type CitationWebSearchResultLocationParam,
  type CitationsConfig,
  type CitationsConfigParam,
  type CitationsDelta,
  type CitationsSearchResultLocation,
  type CitationsWebSearchResultLocation,
  type CodeExecutionOutputBlock,
  type CodeExecutionOutputBlockParam,
  type CodeExecutionResultBlock,
  type CodeExecutionResultBlockParam,
  type CodeExecutionTool20250522,
  type CodeExecutionTool20250825,
  type CodeExecutionTool20260120,
  type CodeExecutionToolResultBlock,
  type CodeExecutionToolResultBlockContent,
  type CodeExecutionToolResultBlockParam,
  type CodeExecutionToolResultBlockParamContent,
  type CodeExecutionToolResultError,
  type CodeExecutionToolResultErrorCode,
  type CodeExecutionToolResultErrorParam,
  type Container,
  type ContainerUploadBlock,
  type ContainerUploadBlockParam,
  type ContentBlock,
  type ContentBlockParam,
  type ContentBlockStartEvent,
  type ContentBlockStopEvent,
  type ContentBlockSource,
  type ContentBlockSourceContent,
  type DirectCaller,
  type DocumentBlock,
  type DocumentBlockParam,
  type EncryptedCodeExecutionResultBlock,
  type EncryptedCodeExecutionResultBlockParam,
  type ImageBlockParam,
  type InputJSONDelta,
  type JSONOutputFormat,
  type MemoryTool20250818,
  type Message,
  type MessageCountTokensTool,
  type MessageDeltaEvent,
  type MessageDeltaUsage,
  type MessageParam,
  type MessageStreamParams,
  type MessageTokensCount,
  type Metadata,
  type Model,
  type OutputConfig,
  type PlainTextSource,
  type RawContentBlockDelta,
  type RawContentBlockDeltaEvent,
  type RawContentBlockStartEvent,
  type RawContentBlockStopEvent,
  type RawMessageDeltaEvent,
  type RawMessageStartEvent,
  type RawMessageStopEvent,
  type RawMessageStreamEvent,
  type RedactedThinkingBlock,
  type RedactedThinkingBlockParam,
  type RefusalStopDetails,
  type SearchResultBlockParam,
  type ServerToolCaller,
  type ServerToolCaller20260120,
  type ServerToolUsage,
  type ServerToolUseBlock,
  type ServerToolUseBlockParam,
  type SignatureDelta,
  type StopReason,
  type TextBlock,
  type TextBlockParam,
  type TextCitation,
  type TextCitationParam,
  type TextDelta,
  type TextEditorCodeExecutionCreateResultBlock,
  type TextEditorCodeExecutionCreateResultBlockParam,
  type TextEditorCodeExecutionStrReplaceResultBlock,
  type TextEditorCodeExecutionStrReplaceResultBlockParam,
  type TextEditorCodeExecutionToolResultBlock,
  type TextEditorCodeExecutionToolResultBlockParam,
  type TextEditorCodeExecutionToolResultError,
  type TextEditorCodeExecutionToolResultErrorCode,
  type TextEditorCodeExecutionToolResultErrorParam,
  type TextEditorCodeExecutionViewResultBlock,
  type TextEditorCodeExecutionViewResultBlockParam,
  type ThinkingBlock,
  type ThinkingBlockParam,
  type ThinkingConfigAdaptive,
  type ThinkingConfigDisabled,
  type ThinkingConfigEnabled,
  type ThinkingConfigParam,
  type ThinkingDelta,
  type Tool,
  type ToolBash20250124,
  type ToolChoice,
  type ToolChoiceAny,
  type ToolChoiceAuto,
  type ToolChoiceNone,
  type ToolChoiceTool,
  type ToolReferenceBlock,
  type ToolReferenceBlockParam,
  type ToolResultBlockParam,
  type ToolSearchToolBm25_20251119,
  type ToolSearchToolRegex20251119,
  type ToolSearchToolResultBlock,
  type ToolSearchToolResultBlockParam,
  type ToolSearchToolResultError,
  type ToolSearchToolResultErrorCode,
  type ToolSearchToolResultErrorParam,
  type ToolSearchToolSearchResultBlock,
  type ToolSearchToolSearchResultBlockParam,
  type ToolTextEditor20250124,
  type ToolTextEditor20250429,
  type ToolTextEditor20250728,
  type ToolUnion,
  type ToolUseBlock,
  type ToolUseBlockParam,
  type URLImageSource,
  type URLPDFSource,
  type Usage,
  type UserLocation,
  type WebFetchBlock,
  type WebFetchBlockParam,
  type WebFetchTool20250910,
  type WebFetchTool20260209,
  type WebFetchTool20260309,
  type WebFetchToolResultBlock,
  type WebFetchToolResultBlockParam,
  type WebFetchToolResultErrorBlock,
  type WebFetchToolResultErrorBlockParam,
  type WebFetchToolResultErrorCode,
  type WebSearchResultBlock,
  type WebSearchResultBlockParam,
  type WebSearchTool20250305,
  type WebSearchTool20260209,
  type WebSearchToolRequestError,
  type WebSearchToolResultBlock,
  type WebSearchToolResultBlockContent,
  type WebSearchToolResultBlockParam,
  type WebSearchToolResultBlockParamContent,
  type WebSearchToolResultError,
  type WebSearchToolResultErrorCode,
  type MessageCreateParams,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
} from './messages/messages';
export {
  Models,
  type CapabilitySupport,
  type ContextManagementCapability,
  type EffortCapability,
  type ModelCapabilities,
  type ModelInfo,
  type ThinkingCapability,
  type ThinkingTypes,
  type ModelRetrieveParams,
  type ModelListParams,
  type ModelInfosPage,
} from './models';
```
### `spine/platform/worker/node_modules/@anthropic-ai/sdk/src/resources/messages/index.ts`
```typescript
// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.
export {
  Batches,
  type DeletedMessageBatch,
  type MessageBatch,
  type MessageBatchCanceledResult,
  type MessageBatchErroredResult,
  type MessageBatchExpiredResult,
  type MessageBatchIndividualResponse,
  type MessageBatchRequestCounts,
  type MessageBatchResult,
  type MessageBatchSucceededResult,
  type BatchCreateParams,
  type BatchListParams,
  type MessageBatchesPage,
} from './batches';
export {
  Messages,
  type Base64ImageSource,
  type Base64PDFSource,
  type BashCodeExecutionOutputBlock,
  type BashCodeExecutionOutputBlockParam,
  type BashCodeExecutionResultBlock,
  type BashCodeExecutionResultBlockParam,
  type BashCodeExecutionToolResultBlock,
  type BashCodeExecutionToolResultBlockParam,
  type BashCodeExecutionToolResultError,
  type BashCodeExecutionToolResultErrorCode,
  type BashCodeExecutionToolResultErrorParam,
  type CacheControlEphemeral,
  type CacheCreation,
  type CitationCharLocation,
  type CitationCharLocationParam,
  type CitationContentBlockLocation,
  type CitationContentBlockLocationParam,
  type CitationPageLocation,
  type CitationPageLocationParam,
  type CitationSearchResultLocationParam,
  type CitationWebSearchResultLocationParam,
  type CitationsConfig,
  type CitationsConfigParam,
  type CitationsDelta,
  type CitationsSearchResultLocation,
  type CitationsWebSearchResultLocation,
  type CodeExecutionOutputBlock,
  type CodeExecutionOutputBlockParam,
  type CodeExecutionResultBlock,
  type CodeExecutionResultBlockParam,
  type CodeExecutionTool20250522,
  type CodeExecutionTool20250825,
  type CodeExecutionTool20260120,
  type CodeExecutionToolResultBlock,
  type CodeExecutionToolResultBlockContent,
  type CodeExecutionToolResultBlockParam,
  type CodeExecutionToolResultBlockParamContent,
  type CodeExecutionToolResultError,
  type CodeExecutionToolResultErrorCode,
  type CodeExecutionToolResultErrorParam,
  type Container,
  type ContainerUploadBlock,
  type ContainerUploadBlockParam,
  type ContentBlock,
  type ContentBlockParam,
  type ContentBlockStartEvent,
  type ContentBlockStopEvent,
  type ContentBlockSource,
  type ContentBlockSourceContent,
  type DirectCaller,
  type DocumentBlock,
  type DocumentBlockParam,
  type EncryptedCodeExecutionResultBlock,
  type EncryptedCodeExecutionResultBlockParam,
  type ImageBlockParam,
  type InputJSONDelta,
  type JSONOutputFormat,
  type MemoryTool20250818,
  type Message,
  type MessageCountTokensTool,
  type MessageDeltaEvent,
  type MessageDeltaUsage,
  type MessageParam,
  type MessageTokensCount,
  type Metadata,
  type Model,
  type OutputConfig,
  type PlainTextSource,
  type RawContentBlockDelta,
  type RawContentBlockDeltaEvent,
  type RawContentBlockStartEvent,
  type RawContentBlockStopEvent,
  type RawMessageDeltaEvent,
  type RawMessageStartEvent,
  type RawMessageStopEvent,
  type RawMessageStreamEvent,
  type RedactedThinkingBlock,
  type RedactedThinkingBlockParam,
  type RefusalStopDetails,
  type SearchResultBlockParam,
  type ServerToolCaller,
  type ServerToolCaller20260120,
  type ServerToolUsage,
  type ServerToolUseBlock,
  type ServerToolUseBlockParam,
  type SignatureDelta,
  type StopReason,
  type TextBlock,
  type TextBlockParam,
  type TextCitation,
  type TextCitationParam,
  type TextDelta,
  type TextEditorCodeExecutionCreateResultBlock,
  type TextEditorCodeExecutionCreateResultBlockParam,
  type TextEditorCodeExecutionStrReplaceResultBlock,
  type TextEditorCodeExecutionStrReplaceResultBlockParam,
  type TextEditorCodeExecutionToolResultBlock,
  type TextEditorCodeExecutionToolResultBlockParam,
  type TextEditorCodeExecutionToolResultError,
  type TextEditorCodeExecutionToolResultErrorCode,
  type TextEditorCodeExecutionToolResultErrorParam,
  type TextEditorCodeExecutionViewResultBlock,
  type TextEditorCodeExecutionViewResultBlockParam,
  type ThinkingBlock,
  type ThinkingBlockParam,
  type ThinkingConfigAdaptive,
  type ThinkingConfigDisabled,
  type ThinkingConfigEnabled,
  type ThinkingConfigParam,
  type ThinkingDelta,
  type Tool,
  type ToolBash20250124,
  type ToolChoice,
  type ToolChoiceAny,
  type ToolChoiceAuto,
  type ToolChoiceNone,
  type ToolChoiceTool,
  type ToolReferenceBlock,
  type ToolReferenceBlockParam,
  type ToolResultBlockParam,
  type ToolSearchToolBm25_20251119,
  type ToolSearchToolRegex20251119,
  type ToolSearchToolResultBlock,
  type ToolSearchToolResultBlockParam,
  type ToolSearchToolResultError,
  type ToolSearchToolResultErrorCode,
  type ToolSearchToolResultErrorParam,
  type ToolSearchToolSearchResultBlock,
  type ToolSearchToolSearchResultBlockParam,
  type ToolTextEditor20250124,
  type ToolTextEditor20250429,
  type ToolTextEditor20250728,
  type ToolUnion,
  type ToolUseBlock,
  type ToolUseBlockParam,
  type URLImageSource,
  type URLPDFSource,
  type Usage,
  type UserLocation,
  type WebFetchBlock,
  type WebFetchBlockParam,
  type WebFetchTool20250910,
  type WebFetchTool20260209,
  type WebFetchTool20260309,
  type WebFetchToolResultBlock,
  type WebFetchToolResultBlockParam,
  type WebFetchToolResultErrorBlock,
  type WebFetchToolResultErrorBlockParam,
  type WebFetchToolResultErrorCode,
  type WebSearchResultBlock,
  type WebSearchResultBlockParam,
  type WebSearchTool20250305,
  type WebSearchTool20260209,
  type WebSearchToolRequestError,
  type WebSearchToolResultBlock,
  type WebSearchToolResultBlockContent,
  type WebSearchToolResultBlockParam,
  type WebSearchToolResultBlockParamContent,
  type WebSearchToolResultError,
  type WebSearchToolResultErrorCode,
  type MessageStreamEvent,
  type MessageStartEvent,
  type MessageStopEvent,
  type ContentBlockDeltaEvent,
  type MessageCreateParams,
  type MessageCreateParamsBase,
  type MessageCreateParamsNonStreaming,
  type MessageCreateParamsStreaming,
  type MessageCountTokensParams,
} from './messages';
```
### `spine/platform/worker/node_modules/zod/src/index.ts`
```typescript
import * as z from "./v4/classic/external.js";
export * from "./v4/classic/external.js";
export { z };
export default z;
```
### `spine/platform/worker/node_modules/zod/src/locales/index.ts`
```typescript
export * from "../v4/locales/index.js";
```
### `spine/platform/worker/node_modules/zod/src/mini/index.ts`
```typescript
import * as z from "../v4/mini/external.js";
export * from "../v4/mini/external.js";
export { z };
```
### `spine/platform/worker/node_modules/zod/src/v3/benchmarks/index.ts`
```typescript
import type Benchmark from "benchmark";
import datetimeBenchmarks from "./datetime.js";
import discriminatedUnionBenchmarks from "./discriminatedUnion.js";
import ipv4Benchmarks from "./ipv4.js";
import objectBenchmarks from "./object.js";
import primitiveBenchmarks from "./primitives.js";
import realworld from "./realworld.js";
import stringBenchmarks from "./string.js";
import unionBenchmarks from "./union.js";
const argv = process.argv.slice(2);
let suites: Benchmark.Suite[] = [];
if (!argv.length) {
  suites = [
    ...realworld.suites,
    ...primitiveBenchmarks.suites,
    ...stringBenchmarks.suites,
    ...objectBenchmarks.suites,
    ...unionBenchmarks.suites,
    ...discriminatedUnionBenchmarks.suites,
  ];
} else {
  if (argv.includes("--realworld")) {
    suites.push(...realworld.suites);
  }
  if (argv.includes("--primitives")) {
    suites.push(...primitiveBenchmarks.suites);
  }
  if (argv.includes("--string")) {
    suites.push(...stringBenchmarks.suites);
  }
  if (argv.includes("--object")) {
    suites.push(...objectBenchmarks.suites);
  }
  if (argv.includes("--union")) {
    suites.push(...unionBenchmarks.suites);
  }
  if (argv.includes("--discriminatedUnion")) {
    suites.push(...datetimeBenchmarks.suites);
  }
  if (argv.includes("--datetime")) {
    suites.push(...datetimeBenchmarks.suites);
  }
  if (argv.includes("--ipv4")) {
    suites.push(...ipv4Benchmarks.suites);
  }
}
for (const suite of suites) {
  suite.run({});
}
// exit on Ctrl-C
process.on("SIGINT", function () {
  console.log("Exiting...");
  process.exit();
});
```
### `spine/platform/worker/node_modules/zod/src/v3/index.ts`
```typescript
import * as z from "./external.js";
export * from "./external.js";
export { z };
export default z;
```
### `spine/platform/worker/node_modules/zod/src/v4/classic/index.ts`
```typescript
import * as z from "./external.js";
export { z };
export * from "./external.js";
export default z;
```
### `spine/platform/worker/node_modules/zod/src/v4/core/index.ts`
```typescript
export * from "./core.js";
export * from "./parse.js";
export * from "./errors.js";
export * from "./schemas.js";
export * from "./checks.js";
export * from "./versions.js";
export * as util from "./util.js";
export * as regexes from "./regexes.js";
export * as locales from "../locales/index.js";
export * from "./registries.js";
export * from "./doc.js";
export * from "./api.js";
export * from "./to-json-schema.js";
export { toJSONSchema } from "./json-schema-processors.js";
export { JSONSchemaGenerator } from "./json-schema-generator.js";
export * as JSONSchema from "./json-schema.js";
```
### `spine/platform/worker/node_modules/zod/src/v4/index.ts`
```typescript
import z4 from "./classic/index.js";
export * from "./classic/index.js";
export default z4;
```
### `spine/platform/worker/node_modules/zod/src/v4/locales/index.ts`
```typescript
export { default as ar } from "./ar.js";
export { default as az } from "./az.js";
export { default as be } from "./be.js";
export { default as bg } from "./bg.js";
export { default as ca } from "./ca.js";
export { default as cs } from "./cs.js";
export { default as da } from "./da.js";
export { default as de } from "./de.js";
export { default as el } from "./el.js";
export { default as en } from "./en.js";
export { default as eo } from "./eo.js";
export { default as es } from "./es.js";
export { default as fa } from "./fa.js";
export { default as fi } from "./fi.js";
export { default as fr } from "./fr.js";
export { default as frCA } from "./fr-CA.js";
export { default as he } from "./he.js";
export { default as hr } from "./hr.js";
export { default as hu } from "./hu.js";
export { default as hy } from "./hy.js";
export { default as id } from "./id.js";
export { default as is } from "./is.js";
export { default as it } from "./it.js";
export { default as ja } from "./ja.js";
export { default as ka } from "./ka.js";
export { default as kh } from "./kh.js";
export { default as km } from "./km.js";
export { default as ko } from "./ko.js";
export { default as lt } from "./lt.js";
export { default as mk } from "./mk.js";
export { default as ms } from "./ms.js";
export { default as nl } from "./nl.js";
export { default as no } from "./no.js";
export { default as ota } from "./ota.js";
export { default as ps } from "./ps.js";
export { default as pl } from "./pl.js";
export { default as pt } from "./pt.js";
export { default as ro } from "./ro.js";
export { default as ru } from "./ru.js";
export { default as sl } from "./sl.js";
export { default as sv } from "./sv.js";
export { default as ta } from "./ta.js";
export { default as th } from "./th.js";
export { default as tr } from "./tr.js";
export { default as ua } from "./ua.js";
export { default as uk } from "./uk.js";
export { default as ur } from "./ur.js";
export { default as uz } from "./uz.js";
export { default as vi } from "./vi.js";
export { default as zhCN } from "./zh-CN.js";
export { default as zhTW } from "./zh-TW.js";
export { default as yo } from "./yo.js";
```
### `spine/platform/worker/node_modules/zod/src/v4/mini/index.ts`
```typescript
import * as z from "./external.js";
export * from "./external.js";
export { z };
```
### `spine/platform/worker/node_modules/zod/src/v4-mini/index.ts`
```typescript
import * as z from "../v4/mini/external.js";
export * from "../v4/mini/external.js";
export { z };
```
### `spine/platform/worker/worker/index.ts`
```typescript
import 'dotenv/config';
import './sentry.js';
import { Worker, type Job } from 'bullmq';
import type { Redis as RedisClient } from 'ioredis';
import type { Server } from 'http';
import { createRedisConnection, QUEUE_NAME, type PdfJobData, type PdfJobResult } from './queue.js';
import {
  downloadFiles,
  uploadResults,
  uploadFile,
  fileExists,
  getSignedUrl,
} from './firebase.js';
import { generateOdpor, closeMcp } from './generate-odpor.js';
import { markdownToDocx } from '../scripts/lib/docx-writer.js';
import { docxToPdf } from './pdf.js';
import { sendResultEmail } from './email.js';
import { logger as baseLogger } from '../lib/logger.js';
import { startHealthServer } from '../lib/health.js';
const logger = baseLogger.child({ service: 'rozporuj-worker' });
// Paths written under results/<sessionId>/ by a successful run. Used to
// short-circuit an idempotent retry without re-running Claude.
const resultPaths = (sessionId: string) => ({
  pdf: `results/${sessionId}/odpor.pdf`,
  docx: `results/${sessionId}/odpor.docx`,
  conversation: `results/${sessionId}/conversation.md`,
});
/** H7 — idempotent short-circuit. If a prior run of this sessionId already
 *  uploaded results/<sessionId>/odpor.pdf, we re-issue signed URLs and resend
 *  the email without re-running Claude / LibreOffice. Matches the CLAUDE.md
 *  rule "All job handlers must be idempotent". */
export const maybeShortCircuit = async (
  sessionId: string,
): Promise<{
  outputPath: string;
  downloadUrl: string;
  docxUrl: string;
  conversationUrl: string;
} | null> => {
  const paths = resultPaths(sessionId);
  const pdfExists = await fileExists(paths.pdf).catch(() => false);
  if (!pdfExists) return null;
  const [downloadUrl, docxUrl, conversationUrl] = await Promise.all([
    getSignedUrl(paths.pdf),
    getSignedUrl(paths.docx).catch(() => ''),
    getSignedUrl(paths.conversation).catch(() => ''),
  ]);
  return { outputPath: paths.pdf, downloadUrl, docxUrl, conversationUrl };
};
export const processJob = async (job: Job<PdfJobData>): Promise<PdfJobResult> => {
  const { sessionId, email, firstName, lastName } = job.data;
  const log = logger.child({ jobId: job.id, sessionId });
  log.info('Job started');
  // H7 idempotency — short-circuit if results already uploaded.
  const cached = await maybeShortCircuit(sessionId);
  if (cached) {
    log.info({ outputPath: cached.outputPath }, 'Idempotent replay: result already exists, resending email only');
    await job.updateProgress(95);
    await sendResultEmail({ to: email, firstName, downloadUrl: cached.downloadUrl, docxUrl: cached.docxUrl });
    await job.updateProgress(100);
    return {
      downloadUrl: cached.downloadUrl,
      docxUrl: cached.docxUrl,
      conversationUrl: cached.conversationUrl,
      outputPath: cached.outputPath,
    };
  }
  // 1. Download uploaded files from Firebase
  await job.updateProgress(10);
  log.info('Downloading files from Firebase...');
  const files = await downloadFiles(sessionId);
  if (files.length === 0) throw new Error(`No files found for session ${sessionId}`);
  log.info({ fileCount: files.length }, 'Files downloaded');
  // 2. Generate legal analysis via Claude API + MCP tools
  await job.updateProgress(20);
  const { markdown, conversationLog } = await generateOdpor(files, { firstName, lastName, prompt: job.data.prompt, userNotes: job.data.userNotes }, (msg) => {
    log.info(msg);
  });
  log.info({ length: markdown.length }, 'Legal analysis generated');
  // 3. Markdown → DOCX
  await job.updateProgress(70);
  log.info('Converting markdown to DOCX...');
  const docxBuffer = await markdownToDocx(markdown, `Odpor proti pokutě — ${firstName} ${lastName}`, {
    style: 'legal',
    showTitle: false,
    headerText: 'Rozporuj.com',
  });
  // 4. DOCX → PDF
  await job.updateProgress(80);
  log.info('Converting DOCX to PDF...');
  const pdfBuffer = await docxToPdf(docxBuffer);
  log.info({ pdfSize: pdfBuffer.length }, 'PDF generated');
  // 5. Upload PDF + DOCX + conversation log to Firebase
  await job.updateProgress(90);
  log.info('Uploading results to Firebase...');
  const [{ outputPath, downloadUrl, docxUrl }, conversationUrl] = await Promise.all([
    uploadResults(sessionId, pdfBuffer, docxBuffer),
    uploadFile(`results/${sessionId}/conversation.md`, Buffer.from(conversationLog, 'utf-8'), 'text/markdown'),
  ]);
  // 6. Send email
  await job.updateProgress(95);
  log.info('Sending result email...');
  await sendResultEmail({ to: email, firstName, downloadUrl, docxUrl });
  await job.updateProgress(100);
  log.info({ outputPath }, 'Job completed successfully');
  return { downloadUrl, docxUrl, conversationUrl, outputPath };
};
// --- Worker setup ---
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);
// Hard ceiling on the full shutdown sequence. Railway typically sends SIGKILL
// ~30s after SIGTERM; we bound the graceful path inside that window.
export const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || '30000', 10);
// M6: Without removeOnComplete / removeOnFail, BullMQ keeps every job record in
// Redis forever — a long-lived worker accumulates thousands of entries and
// eventually exceeds the Railway Redis memory ceiling. These defaults are
// exported so tests can assert the values and callers can override per-queue.
export const REMOVE_ON_COMPLETE: { count: number } = { count: 100 };
export const REMOVE_ON_FAIL: { count: number } = { count: 200 };
// M4: Per-job wallclock budget. Exposed for tests.
export const MAX_ITER_BUDGET_MS = parseInt(process.env.WORKER_MAX_ITER_BUDGET_MS || '300000', 10); // 5 min default
/**
 * H1/H5 — ordered, bounded graceful shutdown.
 *
 * Order: worker.close() (BullMQ drains in-flight jobs) → connection.quit()
 * (ioredis flushes + quits) → closeMcp() (release MCP singleton).
 *
 * Each step is awaited. The entire sequence is bounded by SHUTDOWN_TIMEOUT_MS
 * via Promise.race — if any step hangs (e.g. Redis partition) we still
 * terminate instead of being SIGKILLed by Railway.
 *
 * Exit code is 0 only if every step completed cleanly. On any error or
 * timeout we exit 1 so Railway / systemd can distinguish a drained shutdown
 * from a failed one.
 */
export const runShutdown = async (deps: {
  worker: Pick<Worker, 'close'>;
  connection: Pick<RedisClient, 'quit'>;
  closeMcpClient: () => void;
  healthServer?: Server;
  log: Pick<typeof logger, 'info' | 'error' | 'warn'>;
  timeoutMs: number;
}): Promise<number> => {
  const { worker, connection, closeMcpClient, healthServer, log, timeoutMs } = deps;
  const drain = (async () => {
    // Step 1: close health server if present
    if (healthServer) {
      log.info('Closing health server...');
      await new Promise<void>((resolve) => {
        healthServer.close(() => {
          resolve();
        });
      });
    }
    // Step 2: drain BullMQ worker. `worker.close()` awaits active jobs,
    // stops the queue consumer, and releases locks.
    log.info('Draining BullMQ worker (waits for in-flight jobs)...');
    await worker.close();
    // Step 3: quit ioredis. `quit()` sends QUIT and waits for server ack,
    // unlike `disconnect()` which rips the socket.
    log.info('Closing Redis connection...');
    try {
      await connection.quit();
    } catch (e) {
      // ioredis rejects quit() if the connection is already closed — not fatal.
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Redis quit raised (likely already closed)');
    }
    // Step 4: release MCP singleton. No network handle to close; this just
    // clears the process-global reference so GC can reclaim it.
    log.info('Releasing MCP client...');
    closeMcpClient();
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([drain.then(() => 'ok' as const), timeout]);
    if (result === 'timeout') {
      log.error({ timeoutMs }, 'Shutdown timed out — forcing exit(1)');
      return 1;
    }
    log.info('Graceful shutdown complete');
    return 0;
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'Shutdown failed — exit(1)');
    return 1;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
/** Wire process-level error handlers and signal handlers. Exported for tests. */
export const installProcessHandlers = (handlers: {
  onShutdown: (signal: string) => Promise<void>;
  onFatal: (origin: string, err: unknown) => void;
  processRef?: NodeJS.Process;
}): void => {
  const proc = handlers.processRef ?? process;
  // H6 — without these, a detached promise throw (e.g. from onProgress) kills
  // the worker silently. We log + trigger shutdown + mark exit code 1.
  proc.on('uncaughtException', (err) => handlers.onFatal('uncaughtException', err));
  proc.on('unhandledRejection', (err) => handlers.onFatal('unhandledRejection', err));
  proc.on('SIGTERM', () => {
    void handlers.onShutdown('SIGTERM');
  });
  proc.on('SIGINT', () => {
    void handlers.onShutdown('SIGINT');
  });
};
// --- Bootstrap (skipped under test via NODE_ENV === 'test' or VITEST) ---
const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true' || !!process.env.VITEST;
if (!isTest) {
  const connection = createRedisConnection();
  // Spustit health server (default port 8090 dle konvence)
  const healthPort = parseInt(process.env.HEALTH_PORT || '8090', 10);
  const healthServer: Server = startHealthServer(healthPort, 'worker');
  const worker = new Worker<PdfJobData, PdfJobResult>(QUEUE_NAME, processJob, {
    connection,
    concurrency: CONCURRENCY,
    limiter: { max: 10, duration: 60_000 },
    // M6: cap stored job records so Redis doesn't grow unbounded.
    removeOnComplete: REMOVE_ON_COMPLETE,
    removeOnFail: REMOVE_ON_FAIL,
  });
  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, sessionId: job.data.sessionId }, 'Job completed');
  });
  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, sessionId: job?.data.sessionId, err }, 'Job failed');
  });
  worker.on('error', (err) => {
    logger.error({ error: err.message }, 'Worker error');
  });
  logger.info({ concurrency: CONCURRENCY, queue: QUEUE_NAME, healthPort }, 'Worker started');
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      logger.warn({ signal }, 'Shutdown already in progress');
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    const code = await runShutdown({
      worker,
      connection,
      closeMcpClient: closeMcp,
      healthServer,
      log: logger,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(code);
  };
  const onFatal = (origin: string, err: unknown) => {
    logger.error(
      { origin, err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
      'Fatal error — initiating shutdown',
    );
    // Schedule shutdown; do not block the handler itself.
    void (async () => {
      const code = await runShutdown({
        worker,
        connection,
        closeMcpClient: closeMcp,
        healthServer,
        log: logger,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      // Any fatal always yields exit 1, even if shutdown itself was clean —
      // the originating error is the signal.
      process.exit(code === 0 ? 1 : code);
    })();
  };
  installProcessHandlers({ onShutdown: shutdown, onFatal });
}
```

