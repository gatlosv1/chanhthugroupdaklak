/**
 * Kiểu dữ liệu truy xuất sản xuất xoài đông lạnh.
 * Dùng cho JSDoc (`@type {import('./types').Lot}`) hoặc khi chuyển sang TypeScript.
 */
import type { Timestamp } from 'firebase/firestore';

export type DepartmentId = 'PREPROCESS' | 'PROCESSING' | 'FREEZE_PACK';
export type Role = 'staff' | 'admin' | 'dev';
export type Phase = 'A' | 'B' | 'C';

export type StageId =
  | 'SORT_1' | 'SOAK_1' | 'SOAK_1_1' | 'SORT_2' | 'SOAK_2' | 'SORT_3' | 'SOAK_3' | 'SORT_4'
  | 'PEEL' | 'FLESH' | 'CHECK_FLESH' | 'SHAPE'
  | 'PACK';

export type StageKind = 'sort' | 'soak' | 'wash' | 'process' | 'check' | 'freeze' | 'pack' | 'storage';

/** Trạng thái của một công đoạn trong một lô. */
export type StageStatus = 'pending' | 'in_progress' | 'passed' | 'failed' | 'rejected';

/** Trạng thái tổng của lô (dùng để lọc hàng chờ). */
export type LotStatus = 'waiting' | 'completed' | 'rejected';

export interface StageDefinition {
  id: StageId;
  name: string;
  short: string;            // Mã ngắn dùng đặt tên lô con, ví dụ "U11"
  phase: Phase;
  departmentId: DepartmentId;
  kind: StageKind;
  next: StageId | null;     // Công đoạn kế khi đạt; null = công đoạn cuối
  lightTo: StageId[];       // Nơi nhận phần hư nhẹ (ủ / làm lại)
  rework: boolean;          // lightTo là vòng lặp, bị giới hạn MAX_REWORK
  lightLabel: string;
  byproductLabel?: string;
}

export interface Intake {
  receivedDate: string;     // yyyy-mm-dd
  vehiclePlate: string;
  productType: string;      // Ví dụ "Xoài keo"
  origin: string;
  initialKg: number;
  note?: string;
}

/** Kết quả khối lượng của một lần ghi công đoạn. */
export interface StageResult {
  inputKg: number;
  passedKg: number;
  rejectedHeavyKg: number;  // Hư nặng → loại bỏ
  rejectedLightKg: number;  // Hư nhẹ → ủ / làm lại
  lossKg: number;           // Hao hụt = inputKg - tổng ba phần trên
  soakTarget?: StageId;
  note: string;
}

export interface StageRecord {
  status: StageStatus;
  operatorId?: string;
  operatorName?: string;
  departmentId: DepartmentId;
  enteredAt?: Timestamp;    // Lúc lô vào hàng chờ công đoạn
  startedAt?: Timestamp;
  finishedAt?: Timestamp;
  result?: StageResult;
}

export type HistoryAction =
  | 'CREATE' | 'RECORD_RESULT' | 'SEND_TO_SOAK' | 'REJECT' | 'SPLIT_FROM_PARENT';

export interface HistoryEntry {
  stage: StageId;
  action: HistoryAction;
  fromStatus: StageStatus | null;
  toStatus: StageStatus | null;
  operatorId: string;
  operatorName: string;
  timestamp: Timestamp;
  note?: string;
  kgData?: Partial<StageResult> & {
    initialKg?: number;
    nextStage?: StageId;
    childLotId?: string;
    childLotCode?: string;
    childStage?: StageId;
    parentLotId?: string;
    parentLotCode?: string;
    lightKg?: number;
    completed?: boolean;
  };
}

/** Document `lots/{lotId}`. Lô cũ có thể thiếu currentStage/currentKg/stages/history. */
export interface Lot {
  id: string;                          // Id document (thêm khi đọc, không lưu trong document)
  lotCode: string;
  parentLotIds: string[];
  createdAt: Timestamp;
  createdBy?: string;
  updatedAt: Timestamp;
  status: LotStatus;
  intake: Intake;
  currentStage: StageId;
  currentKg: number;                   // Khối lượng đang xử lý tại công đoạn hiện tại
  reworkCount: number;
  childCount?: number;
  stageEnteredAt?: Timestamp;
  stages: Partial<Record<StageId, StageRecord>>;
  history: HistoryEntry[];
  // Trường tương thích ngược với hàng chờ cũ
  pendingStageId: StageId | null;
  pendingDepartmentId: DepartmentId | null;
  lastStageId?: StageId;
}

/** Payload gọi updateLotStage. inputKg do server tự tính, client chỉ gửi expectedInputKg để phát hiện lệch. */
export interface UpdateLotStageRequest {
  lotId: string;
  stageId: StageId;
  passedKg: number;
  rejectedHeavyKg: number;
  rejectedLightKg: number;
  soakTarget?: StageId;
  expectedInputKg?: number;
  note?: string;
}

export interface SendToSoakRequest {
  lotId: string;
  stageId: StageId;
  soakTarget?: StageId;
  expectedInputKg?: number;
  note?: string;
}

export interface RejectLotRequest {
  lotId: string;
  stageId: StageId;
  note: string;                        // Lý do loại bỏ, bắt buộc
  expectedInputKg?: number;
}

export interface StageActionResponse {
  lotId: string;
  lotCode: string;
  outcome: 'passed' | 'failed' | 'rejected';
  nextStage: StageId | null;
  completed: boolean;
  lossKg: number;
  child: { id: string; lotCode: string; stageId: StageId } | null;
}
