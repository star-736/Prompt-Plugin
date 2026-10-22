// Persisted contracts are additive: unknown fields survive normalization and
// backups. These interfaces do not replace runtime validation of imported data.
export type AssetType = 'generic' | 'skill' | 'aigc' | 'command';
export type Privacy = 'normal' | 'private';
export type LibraryScope = Exclude<AssetType, 'aigc'> | 'aigc-normal' | 'aigc-private';
export type CategoryScope = Exclude<LibraryScope, 'aigc-private'>;
export type SortBy = 'updated' | 'lastUsed' | 'mostUsed';
export type AgentTarget = 'claude' | 'cursor' | 'codex' | 'hermes' | 'agents';
export interface DeliveryRecord {
  slug: string;
  deliveredAt: number | null;
  contentUpdatedAt: number | null;
}
export interface SkillDelivery { targets: Partial<Record<AgentTarget, DeliveryRecord>> }
export interface DeliveryMarker extends DeliveryRecord {
  source: 'futurecontext';
  assetId: string;
  target: AgentTarget;
}
export interface GitHubSource {
  repository: string;
  directory: string;
  commit: string;
  defaultBranch?: string | null;
  url?: string;
}
export interface PackageFile {
  path: string;
  content?: string;
  encoding?: string;
  contentType?: string;
  sourcePath?: string;
  size?: number;
  sha?: string;
}
export interface SkillPackage {
  id: string;
  files: PackageFile[];
  skillContent?: string;
  fileCount?: number;
  totalSize?: number;
  source?: GitHubSource;
}
export interface CollectedSkillPackage extends SkillPackage {
  skillContent: string;
  fileCount: number;
  totalSize: number;
  source: GitHubSource;
}
export interface AssetInput {
  id?: string | null;
  type: AssetType;
  privacy?: Privacy;
  title?: string;
  content: string;
  categoryId?: string | null;
  templateEnabled?: boolean;
}
export interface Asset extends AssetInput {
  id: string;
  privacy: Privacy;
  title: string;
  categoryId: string | null;
  skillDescription?: string | null;
  skillPackage?: { packageId: string; source: GitHubSource; fileCount?: number; totalSize?: number } | null;
  skillDelivery?: SkillDelivery;
  titleSource?: string | null;
  categorySource?: string | null;
  createdAt: number;
  updatedAt: number;
  useCount?: number;
  lastUsedAt?: number | null;
  pinned?: boolean;
}
export interface Category { id: string; scope: CategoryScope; name: string; createdAt: number; createdBy: string }
export interface DraftReference { type: AssetType; privacy?: Privacy; id?: string | null }
export interface EditorValues { title: string; content: string; categoryId: string | null; templateEnabled?: boolean }
export interface Draft extends EditorValues { updatedAt: number }
export interface ProviderSecret { algorithm: string; salt: string; iv: string; ciphertext: string }
export type ProviderKind = 'openai' | 'opencode_go' | 'deepseek' | 'openrouter' | 'custom';
export interface Provider {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  model: string;
  secret?: ProviderSecret | null;
  createdAt: number;
  updatedAt?: number;
}
export interface ProviderInput extends Partial<Provider> { apiKey?: string }
export interface AiQueueEntry { id: string; assetId: string; assetType: AssetType; queuedAt: number }
export interface CategoryGroup { name: string; assetIds: string[] }
export interface StructureGroup { from: string[]; to: string }
export interface StructureProposal {
  id: string; status: string; createdAt: number; scope: CategoryScope;
  summary: string; groups: StructureGroup[]; resolvedAt?: number;
}
export interface InPlaceSettings { enabled: boolean; triggerEnabled: boolean; sites: string[]; ignoredSites: string[] }
export interface AiSettings {
  enabled: boolean;
  activeProviderId: string | null;
  providers: Provider[];
  queue: AiQueueEntry[];
  proposals: StructureProposal[];
  status: { state: string; message: string; updatedAt?: number };
  thresholds: { uncategorized: number; restructureChanges: number; restructureDays: number };
  lastRestructureAt: number | null;
  changeCountSinceRestructure: number;
}
export interface Database {
  version: number;
  revision: number;
  lock: { passwordDigest: string | null };
  settings: { lastNormalTab: AssetType; sortBy: Partial<Record<string, SortBy>>; inPlace: InPlaceSettings };
  ai: AiSettings;
  usage: { log: number[] };
  assets: Asset[];
  categories: Category[];
  drafts: Record<string, Draft>;
  syncWithdrawals?: string[];
  syncLedger?: { repository: string; records: SyncRecords };
}
export interface Backup { format: string; version: number; exportedAt?: number; categories: Category[]; assets: Asset[]; packages: SkillPackage[] }
export interface PackageMapping { sourcePackageId: string; targetPackageId: string }
export interface BackupMerge { database: Database; imported: number; skipped: number; packages: SkillPackage[]; packageImports: PackageMapping[] }
export interface AssetSave { database: Database; asset: Asset; queued: boolean; duplicate?: boolean }
export interface StorageAdapter {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}
export type DatabaseChange = (current: Database) => Database | { database: Database } | null | undefined | Promise<Database | { database: Database } | null | undefined>;
export interface LockOptions { locks?: LockManager; lockTimeout?: number }
export interface ChangeOptions extends LockOptions { attempts?: number; onSaved?: (database: Database) => void }
export interface DiskInspection {
  kind: 'missing' | 'foreign' | 'ours' | 'ours-other';
  marker?: DeliveryMarker;
  slug?: string;
  current?: boolean;
  directory?: FileSystemDirectoryHandle;
}
export interface DeliveryStatus {
  state: 'idle' | 'stale' | 'delivered' | 'present' | 'outdated' | 'unbound';
  record: DeliveryRecord | null;
  slug?: string | null;
  via?: string;
  unconfirmed?: boolean;
}
export interface DiskDeliveryUpdate { assetId: string; target: string; status: DeliveryStatus }
export interface AgentBinding { id: AgentTarget; handle: FileSystemDirectoryHandle; displayName?: string; boundAt?: number }
export interface PackageTreeNode { type: 'dir' | 'file'; name: string; path: string; children?: PackageTreeNode[]; file?: PackageFile }

export interface SyncValue extends Partial<Asset>, Partial<Category> {
  id: string;
  package?: { files: PackageFile[]; source: GitHubSource };
}
export interface SyncRecord { value?: SyncValue; deleted?: true; withdrawn?: true }
export type SyncRecords = Record<string, SyncRecord>;
export interface SyncDocument { format: string; version: number; records: SyncRecords }
export interface SyncConfig { repository: string; token: string; enabled: boolean; automatic: boolean; generation: string }
export interface SyncStatus { state: string; message: string; lastSyncedAt?: number; conflicts?: number }
export interface SyncSettings { repository: string; enabled: boolean; automatic: boolean; configured: boolean; status: SyncStatus }
export interface SyncDraft { repository: string; token: string; enabled: boolean; automatic: boolean }
