export type TabKey = 'feed' | 'members' | 'tasks' | 'profile';

export type PaymentMethod = 'bKash' | 'Nagad' | 'Rocket';

export type RequestStatus = 'pending' | 'approved' | 'rejected';

export interface PaymentNumbers {
  bKash: string;
  Nagad: string;
  Rocket: string;
}

export type PackageTier = 'silver' | 'gold' | 'diamond';

export interface PremiumPackage {
  id: string;
  tier: PackageTier;
  name: string;
  price: number;
  dailyIncome: number;
  durationDays: number;
  description: string;
}

export interface User {
  id: string;
  name: string;
  username: string;
  password?: string;
  email?: string;
  bio: string;
  avatar: string;
  balance: number;
  unlockedPackages?: string[];
}

export interface UserWalletDoc {
  userId: string;
  email: string;
  balance: number;
  unlockedPackages: string[];
  lastPurchasePkgId: string;
  lastClaimId: string;
  lastWithdrawalId: string;
}

export interface Post {
  id: string;
  userId: string;
  text: string;
  image: string;
  likes: string[];
  likesCount?: number;
  timestamp: string;
}

export interface Task {
  id: string;
  title: string;
  desc: string;
  target: string;
  reward: number;
  isPremium?: boolean;
  requiredTier?: PackageTier;
  durationDays?: number;
  isActive?: boolean;
}

export interface DailyClaim {
  id: string;
  userId: string;
  taskId: string;
  amount: number;
  dateKey: string;
  proof: string;
  timestamp: string;
}

export interface TaskSubmission {
  id: string;
  taskId: string;
  userId: string;
  proof: string;
  status: RequestStatus;
  rewardSnapshot?: number;
  timestamp: string;
}

export interface DepositRequest {
  id: string;
  userId: string;
  method: PaymentMethod;
  sender: string;
  amount: number;
  trxId: string;
  status: RequestStatus;
  timestamp: string;
}

export interface WithdrawRequest {
  id: string;
  userId: string;
  method: PaymentMethod;
  accountNumber: string;
  amount: number;
  status: RequestStatus;
  timestamp: string;
}

export interface ChatMessage {
  id?: string;
  senderId: string;
  text: string;
  time: string;
}

export interface AppState {
  paymentNumbers: PaymentNumbers;
  minPremiumRate: number;
  adminPinHash?: string;
  users: User[];
  posts: Post[];
  tasks: Task[];
  premiumPackages: PremiumPackage[];
  dailyClaims: DailyClaim[];
  submissions: TaskSubmission[];
  deposits: DepositRequest[];
  withdrawals: WithdrawRequest[];
  messages: Record<string, ChatMessage[]>;
}

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
}
