import type { User as FirebaseUser } from 'firebase/auth';
import {
  Timestamp,
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { defaultData } from '../data/seed';
import { ADMIN_EMAIL, OperationType, db, handleFirestoreError } from '../firebase';
import type {
  ChatMessage,
  DailyClaim,
  DepositRequest,
  PackageTier,
  PaymentMethod,
  PaymentNumbers,
  Post,
  PremiumPackage,
  Task,
  TaskSubmission,
  User,
  UserWalletDoc,
  WithdrawRequest,
} from '../types';
import { DEFAULT_ADMIN_PASSCODE, hashPasscode } from '../utils/security';

function toMillis(val: unknown): number {
  if (val instanceof Timestamp) return val.toMillis();
  if (val && typeof val === 'object' && 'toMillis' in val && typeof (val as { toMillis: () => number }).toMillis === 'function') {
    return (val as { toMillis: () => number }).toMillis();
  }
  return 0;
}

function formatNowLabel(): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = now.toLocaleDateString('bn-BD');
  return `${dateStr}, ${timeStr}`.slice(0, 64);
}

function formatTimeOnlyLabel(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).slice(0, 32);
}

function buildSafeUsername(email: string | null, uid: string): string {
  const base = (email?.split('@')[0] || 'member')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '');
  const prefix = (base.length >= 2 ? base : 'member').slice(0, 28);
  const suffix = uid
    .slice(0, 6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '0');
  return `${prefix}_${suffix}`.slice(0, 40);
}

export function isAdminEmail(fbUser: FirebaseUser | null): boolean {
  return Boolean(
    fbUser && fbUser.email === ADMIN_EMAIL && fbUser.emailVerified === true
  );
}

export async function ensureUserProvisioned(fbUser: FirebaseUser): Promise<void> {
  const uid = fbUser.uid;
  const userRef = doc(db, 'users', uid);
  const walletRef = doc(db, 'user_wallets', uid);

  try {
    const [userSnap, walletSnap] = await Promise.all([
      getDoc(userRef),
      getDoc(walletRef),
    ]);

    if (!userSnap.exists()) {
      const safeName = (fbUser.displayName || 'নতুন সদস্য').trim().slice(0, 80) || 'নতুন সদস্য';
      const safeAvatar =
        fbUser.photoURL && fbUser.photoURL.length <= 500 ? fbUser.photoURL : '';
      await setDoc(userRef, {
        id: uid,
        name: safeName,
        username: buildSafeUsername(fbUser.email, uid),
        bio: 'কথা ও আয় পরিবারের সদস্য।',
        avatar: safeAvatar,
        visibility: 'public',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    if (!walletSnap.exists()) {
      await setDoc(walletRef, {
        userId: uid,
        email: (fbUser.email || `${uid}@users.local`).slice(0, 160),
        balance: 20,
        unlockedPackages: [],
        lastPurchasePkgId: '',
        lastClaimId: '',
        lastWithdrawalId: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}`);
  }
}

export async function seedInitialCatalogIfAdmin(fbUser: FirebaseUser): Promise<void> {
  if (!isAdminEmail(fbUser)) return;

  try {
    const settingsRef = doc(db, 'app_settings', 'public');
    const settingsSnap = await getDoc(settingsRef);
    if (!settingsSnap.exists()) {
      await setDoc(settingsRef, {
        bKash: defaultData.paymentNumbers.bKash,
        Nagad: defaultData.paymentNumbers.Nagad,
        Rocket: defaultData.paymentNumbers.Rocket,
        minPremiumRate: defaultData.minPremiumRate,
        updatedAt: serverTimestamp(),
      });
    }

    const secretRef = doc(db, 'admin_secrets', 'passcode');
    const secretSnap = await getDoc(secretRef);
    if (!secretSnap.exists()) {
      const initialHash = await hashPasscode(DEFAULT_ADMIN_PASSCODE);
      await setDoc(secretRef, {
        adminPinHash: initialHash,
        updatedAt: serverTimestamp(),
      });
    }

    const pkgSnap = await getDocs(
      query(collection(db, 'premium_packages'), where('visibility', '==', 'public'))
    );
    if (pkgSnap.empty) {
      const batch = writeBatch(db);
      for (const pkg of defaultData.premiumPackages) {
        batch.set(doc(db, 'premium_packages', pkg.id), {
          id: pkg.id,
          tier: pkg.tier,
          name: pkg.name.slice(0, 100),
          price: pkg.price,
          dailyIncome: pkg.dailyIncome,
          durationDays: pkg.durationDays,
          description: pkg.description.slice(0, 500),
          visibility: 'public',
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }

    const tasksSnap = await getDocs(collection(db, 'tasks'));
    if (tasksSnap.empty) {
      const batch = writeBatch(db);
      for (const task of defaultData.tasks) {
        batch.set(doc(db, 'tasks', task.id), {
          id: task.id,
          title: task.title.slice(0, 150),
          desc: task.desc.slice(0, 1000),
          target: task.target.slice(0, 100),
          reward: task.reward,
          isPremium: Boolean(task.isPremium),
          requiredTier: task.isPremium ? task.requiredTier || 'silver' : 'none',
          durationDays: task.durationDays || 30,
          isActive: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'app_settings/public');
  }
}

export interface RealtimeStoreCallbacks {
  onUsers: (users: Omit<User, 'balance' | 'unlockedPackages' | 'email'>[]) => void;
  onMyWallet: (wallet: UserWalletDoc | null) => void;
  onAllWallets: (wallets: Record<string, UserWalletDoc>) => void;
  onPosts: (posts: { id: string; userId: string; text: string; image: string; likesCount: number; timestamp: string }[]) => void;
  onMyLikedPostIds: (likedIds: Set<string>) => void;
  onPackages: (packages: PremiumPackage[]) => void;
  onTasks: (tasks: Task[]) => void;
  onSubmissions: (subs: TaskSubmission[]) => void;
  onDailyClaims: (claims: DailyClaim[]) => void;
  onDeposits: (deps: DepositRequest[]) => void;
  onWithdrawals: (wds: WithdrawRequest[]) => void;
  onPublicSettings: (settings: { paymentNumbers: PaymentNumbers; minPremiumRate: number }) => void;
  onAdminPinHash: (pinHash: string) => void;
}

export function subscribeToAppData(
  fbUser: FirebaseUser,
  callbacks: RealtimeStoreCallbacks
): () => void {
  const uid = fbUser.uid;
  const admin = isAdminEmail(fbUser);
  const unsubs: Unsubscribe[] = [];

  // 1. Public member profiles
  unsubs.push(
    onSnapshot(
      query(collection(db, 'users'), where('visibility', '==', 'public')),
      (snap) => {
        const list = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: String(data.id || d.id),
            name: String(data.name || 'সদস্য'),
            username: String(data.username || 'user'),
            bio: String(data.bio || ''),
            avatar: String(data.avatar || ''),
          };
        });
        callbacks.onUsers(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'users')
    )
  );

  // 2. Current user's private wallet
  unsubs.push(
    onSnapshot(
      doc(db, 'user_wallets', uid),
      (snap) => {
        if (!snap.exists()) {
          callbacks.onMyWallet(null);
          return;
        }
        const data = snap.data();
        callbacks.onMyWallet({
          userId: String(data.userId || uid),
          email: String(data.email || ''),
          balance: Number(data.balance ?? 0),
          unlockedPackages: Array.isArray(data.unlockedPackages)
            ? data.unlockedPackages.map(String)
            : [],
          lastPurchasePkgId: String(data.lastPurchasePkgId || ''),
          lastClaimId: String(data.lastClaimId || ''),
          lastWithdrawalId: String(data.lastWithdrawalId || ''),
        });
      },
      (error) => handleFirestoreError(error, OperationType.GET, `user_wallets/${uid}`)
    )
  );

  // 2b. Admin-only full wallets listener (for subscriber counts & dashboard)
  if (admin) {
    unsubs.push(
      onSnapshot(
        collection(db, 'user_wallets'),
        (snap) => {
          const map: Record<string, UserWalletDoc> = {};
          snap.docs.forEach((d) => {
            const data = d.data();
            map[d.id] = {
              userId: String(data.userId || d.id),
              email: String(data.email || ''),
              balance: Number(data.balance ?? 0),
              unlockedPackages: Array.isArray(data.unlockedPackages)
                ? data.unlockedPackages.map(String)
                : [],
              lastPurchasePkgId: String(data.lastPurchasePkgId || ''),
              lastClaimId: String(data.lastClaimId || ''),
              lastWithdrawalId: String(data.lastWithdrawalId || ''),
            };
          });
          callbacks.onAllWallets(map);
        },
        (error) => handleFirestoreError(error, OperationType.LIST, 'user_wallets')
      )
    );
  }

  // 3. Posts
  unsubs.push(
    onSnapshot(
      query(collection(db, 'posts'), where('visibility', '==', 'public')),
      (snap) => {
        const rows = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: String(data.id || d.id),
              userId: String(data.userId || ''),
              text: String(data.text || ''),
              image: String(data.image || ''),
              likesCount: Number(data.likesCount ?? 0),
              timestamp: String(data.timestampLabel || ''),
              _ms: toMillis(data.createdAt),
            };
          })
          .sort((a, b) => b._ms - a._ms)
          .map(({ _ms: _, ...rest }) => rest);
        callbacks.onPosts(rows);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'posts')
    )
  );

  // 4. Current user's liked posts via collectionGroup
  unsubs.push(
    onSnapshot(
      query(collectionGroup(db, 'likes'), where('userId', '==', uid)),
      (snap) => {
        const liked = new Set<string>();
        snap.docs.forEach((d) => {
          const postId = d.data().postId;
          if (typeof postId === 'string') liked.add(postId);
        });
        callbacks.onMyLikedPostIds(liked);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'likes')
    )
  );

  // 5. Premium packages
  unsubs.push(
    onSnapshot(
      query(collection(db, 'premium_packages'), where('visibility', '==', 'public')),
      (snap) => {
        if (snap.empty) {
          callbacks.onPackages(defaultData.premiumPackages);
          return;
        }
        const rank: Record<string, number> = { silver: 1, gold: 2, diamond: 3 };
        const pkgs: PremiumPackage[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: String(data.id || d.id),
              tier: (data.tier as PackageTier) || 'silver',
              name: String(data.name || ''),
              price: Number(data.price ?? 0),
              dailyIncome: Number(data.dailyIncome ?? 0),
              durationDays: Number(data.durationDays ?? 30),
              description: String(data.description || ''),
            };
          })
          .sort((a, b) => (rank[a.tier] || 9) - (rank[b.tier] || 9));
        callbacks.onPackages(pkgs);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'premium_packages')
    )
  );

  // 6. Tasks
  const tasksQuery = admin
    ? collection(db, 'tasks')
    : query(collection(db, 'tasks'), where('isActive', '==', true));
  unsubs.push(
    onSnapshot(
      tasksQuery,
      (snap) => {
        if (snap.empty) {
          callbacks.onTasks([]);
          return;
        }
        const list: Task[] = snap.docs
          .map((d) => {
            const data = d.data();
            const isPremium = Boolean(data.isPremium);
            const tierRaw = String(data.requiredTier || 'none');
            return {
              id: String(data.id || d.id),
              title: String(data.title || ''),
              desc: String(data.desc || ''),
              target: String(data.target || ''),
              reward: Number(data.reward ?? 0),
              isPremium,
              requiredTier:
                isPremium && (tierRaw === 'silver' || tierRaw === 'gold' || tierRaw === 'diamond')
                  ? (tierRaw as PackageTier)
                  : undefined,
              durationDays: Number(data.durationDays ?? 30),
              isActive: Boolean(data.isActive ?? true),
              _ms: toMillis(data.createdAt),
            };
          })
          .sort((a, b) => b._ms - a._ms)
          .map(({ _ms: _, ...rest }) => rest);
        callbacks.onTasks(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'tasks')
    )
  );

  // 7. Task submissions
  const subsQuery = admin
    ? collection(db, 'submissions')
    : query(collection(db, 'submissions'), where('userId', '==', uid));
  unsubs.push(
    onSnapshot(
      subsQuery,
      (snap) => {
        const list: TaskSubmission[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: String(data.id || d.id),
              taskId: String(data.taskId || ''),
              userId: String(data.userId || ''),
              proof: String(data.proof || ''),
              status: (data.status as TaskSubmission['status']) || 'pending',
              rewardSnapshot: Number(data.rewardSnapshot ?? 0),
              timestamp: String(data.timestampLabel || ''),
              _ms: toMillis(data.createdAt),
            };
          })
          .sort((a, b) => b._ms - a._ms)
          .map(({ _ms: _, ...rest }) => rest);
        callbacks.onSubmissions(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'submissions')
    )
  );

  // 8. Daily claims
  const claimsQuery = admin
    ? collection(db, 'daily_claims')
    : query(collection(db, 'daily_claims'), where('userId', '==', uid));
  unsubs.push(
    onSnapshot(
      claimsQuery,
      (snap) => {
        const list: DailyClaim[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: String(data.id || d.id),
              userId: String(data.userId || ''),
              taskId: String(data.taskId || ''),
              amount: Number(data.amount ?? 0),
              dateKey: String(data.dateKey || ''),
              proof: String(data.proof || ''),
              timestamp: String(data.timestampLabel || ''),
              _ms: toMillis(data.createdAt),
            };
          })
          .sort((a, b) => b._ms - a._ms)
          .map(({ _ms: _, ...rest }) => rest);
        callbacks.onDailyClaims(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'daily_claims')
    )
  );

  // 9. Deposits
  const depositsQuery = admin
    ? collection(db, 'deposits')
    : query(collection(db, 'deposits'), where('userId', '==', uid));
  unsubs.push(
    onSnapshot(
      depositsQuery,
      (snap) => {
        const list: DepositRequest[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: String(data.id || d.id),
              userId: String(data.userId || ''),
              method: (data.method as PaymentMethod) || 'bKash',
              sender: String(data.sender || ''),
              amount: Number(data.amount ?? 0),
              trxId: String(data.trxId || ''),
              status: (data.status as DepositRequest['status']) || 'pending',
              timestamp: String(data.timestampLabel || ''),
              _ms: toMillis(data.createdAt),
            };
          })
          .sort((a, b) => b._ms - a._ms)
          .map(({ _ms: _, ...rest }) => rest);
        callbacks.onDeposits(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'deposits')
    )
  );

  // 10. Withdrawals
  const withdrawalsQuery = admin
    ? collection(db, 'withdrawals')
    : query(collection(db, 'withdrawals'), where('userId', '==', uid));
  unsubs.push(
    onSnapshot(
      withdrawalsQuery,
      (snap) => {
        const list: WithdrawRequest[] = snap.docs
          .map((d) => {
            const data = d.data();
            return {
              id: String(data.id || d.id),
              userId: String(data.userId || ''),
              method: (data.method as PaymentMethod) || 'bKash',
              accountNumber: String(data.accountNumber || ''),
              amount: Number(data.amount ?? 0),
              status: (data.status as WithdrawRequest['status']) || 'pending',
              timestamp: String(data.timestampLabel || ''),
              _ms: toMillis(data.createdAt),
            };
          })
          .sort((a, b) => b._ms - a._ms)
          .map(({ _ms: _, ...rest }) => rest);
        callbacks.onWithdrawals(list);
      },
      (error) => handleFirestoreError(error, OperationType.LIST, 'withdrawals')
    )
  );

  // 11. Public settings
  unsubs.push(
    onSnapshot(
      doc(db, 'app_settings', 'public'),
      (snap) => {
        if (!snap.exists()) {
          callbacks.onPublicSettings({
            paymentNumbers: defaultData.paymentNumbers,
            minPremiumRate: defaultData.minPremiumRate,
          });
          return;
        }
        const data = snap.data();
        callbacks.onPublicSettings({
          paymentNumbers: {
            bKash: String(data.bKash || defaultData.paymentNumbers.bKash),
            Nagad: String(data.Nagad || defaultData.paymentNumbers.Nagad),
            Rocket: String(data.Rocket || defaultData.paymentNumbers.Rocket),
          },
          minPremiumRate: Number(data.minPremiumRate ?? defaultData.minPremiumRate),
        });
      },
      (error) => handleFirestoreError(error, OperationType.GET, 'app_settings/public')
    )
  );

  // 12. Admin PIN hash (admin-only)
  if (admin) {
    unsubs.push(
      onSnapshot(
        doc(db, 'admin_secrets', 'passcode'),
        (snap) => {
          if (snap.exists() && typeof snap.data().adminPinHash === 'string') {
            callbacks.onAdminPinHash(snap.data().adminPinHash);
          }
        },
        (error) => handleFirestoreError(error, OperationType.GET, 'admin_secrets/passcode')
      )
    );
  }

  return () => {
    unsubs.forEach((unsub) => unsub());
  };
}

export function subscribeToChatRoom(
  currentUid: string,
  partnerUid: string,
  onMessages: (messages: ChatMessage[]) => void
): () => void {
  const [participantA, participantB] = [currentUid, partnerUid].sort();
  const roomId = `${participantA}_${participantB}`;
  const filterField = currentUid === participantA ? 'participantA' : 'participantB';

  const q = query(
    collection(db, 'chats', roomId, 'messages'),
    where(filterField, '==', currentUid)
  );

  return onSnapshot(
    q,
    (snap) => {
      const msgs: ChatMessage[] = snap.docs
        .map((d) => {
          const data = d.data();
          return {
            id: d.id,
            senderId: String(data.senderId || ''),
            text: String(data.text || ''),
            time: String(data.timeLabel || ''),
            _ms: toMillis(data.createdAt),
          };
        })
        .sort((a, b) => a._ms - b._ms)
        .map(({ _ms: _, ...rest }) => rest);
      onMessages(msgs);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, `chats/${roomId}/messages`)
  );
}

// ==================== MUTATIONS ====================

export async function createPostInDb(uid: string, text: string, image: string): Promise<void> {
  const postId = `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const path = `posts/${postId}`;
  try {
    await setDoc(doc(db, 'posts', postId), {
      id: postId,
      userId: uid,
      text: text.trim().slice(0, 2000),
      image: image.trim().slice(0, 300000),
      likesCount: 0,
      visibility: 'public',
      timestampLabel: formatNowLabel(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function togglePostLikeInDb(
  uid: string,
  postId: string,
  currentlyLiked: boolean,
  currentLikesCount: number
): Promise<void> {
  const path = `posts/${postId}/likes/${uid}`;
  try {
    const batch = writeBatch(db);
    const likeRef = doc(db, 'posts', postId, 'likes', uid);
    const postRef = doc(db, 'posts', postId);

    if (currentlyLiked) {
      batch.delete(likeRef);
      batch.update(postRef, {
        likesCount: Math.max(0, currentLikesCount - 1),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(likeRef, {
        userId: uid,
        postId,
        createdAt: serverTimestamp(),
      });
      batch.update(postRef, {
        likesCount: currentLikesCount + 1,
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function sendChatMessageInDb(
  senderUid: string,
  partnerUid: string,
  text: string
): Promise<void> {
  const [participantA, participantB] = [senderUid, partnerUid].sort();
  const roomId = `${participantA}_${participantB}`;
  const roomRef = doc(db, 'chats', roomId);
  const msgId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const msgRef = doc(db, 'chats', roomId, 'messages', msgId);

  try {
    const roomSnap = await getDoc(roomRef);
    if (!roomSnap.exists()) {
      await setDoc(roomRef, {
        id: roomId,
        participantA,
        participantB,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(roomRef, {
        updatedAt: serverTimestamp(),
      });
    }

    await setDoc(msgRef, {
      id: msgId,
      roomId,
      senderId: senderUid,
      participantA,
      participantB,
      text: text.trim().slice(0, 2000),
      timeLabel: formatTimeOnlyLabel(),
      createdAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `chats/${roomId}/messages/${msgId}`);
  }
}

export async function updateUserProfileInDb(
  uid: string,
  payload: { name: string; bio: string; avatar: string }
): Promise<void> {
  const path = `users/${uid}`;
  try {
    await updateDoc(doc(db, 'users', uid), {
      name: payload.name.trim().slice(0, 80),
      bio: payload.bio.trim().slice(0, 300),
      avatar: payload.avatar.trim().slice(0, 500),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function purchasePackageInDb(
  wallet: UserWalletDoc,
  pkg: PremiumPackage
): Promise<void> {
  const path = `user_wallets/${wallet.userId}/purchases/${pkg.id}`;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'user_wallets', wallet.userId, 'purchases', pkg.id), {
      userId: wallet.userId,
      packageId: pkg.id,
      price: pkg.price,
      createdAt: serverTimestamp(),
    });
    batch.update(doc(db, 'user_wallets', wallet.userId), {
      balance: wallet.balance - pkg.price,
      unlockedPackages: [...wallet.unlockedPackages, pkg.id],
      lastPurchasePkgId: pkg.id,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function claimDailyTaskInDb(
  wallet: UserWalletDoc,
  task: Task,
  dateKey: string,
  proof: string
): Promise<void> {
  const claimId = `${wallet.userId}_${task.id}_${dateKey}`;
  const path = `daily_claims/${claimId}`;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'daily_claims', claimId), {
      id: claimId,
      userId: wallet.userId,
      taskId: task.id,
      amount: Number(task.reward),
      dateKey,
      proof: proof.trim().slice(0, 500),
      timestampLabel: formatNowLabel(),
      createdAt: serverTimestamp(),
    });
    batch.update(doc(db, 'user_wallets', wallet.userId), {
      balance: wallet.balance + Number(task.reward),
      lastClaimId: claimId,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function submitRegularTaskInDb(
  uid: string,
  task: Task,
  proof: string
): Promise<void> {
  const subId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const path = `submissions/${subId}`;
  try {
    await setDoc(doc(db, 'submissions', subId), {
      id: subId,
      taskId: task.id,
      userId: uid,
      proof: proof.trim().slice(0, 1000),
      status: 'pending',
      rewardSnapshot: Number(task.reward),
      timestampLabel: formatNowLabel(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function submitDepositInDb(
  uid: string,
  payload: { method: PaymentMethod; amount: number; sender: string; trxId: string }
): Promise<void> {
  const depId = `d_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const path = `deposits/${depId}`;
  const cleanTrxId = payload.trxId.trim().toUpperCase().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  try {
    await setDoc(doc(db, 'deposits', depId), {
      id: depId,
      userId: uid,
      method: payload.method,
      sender: payload.sender.trim().slice(0, 30),
      amount: Number(payload.amount),
      trxId: cleanTrxId,
      status: 'pending',
      timestampLabel: formatNowLabel(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function submitWithdrawalInDb(
  wallet: UserWalletDoc,
  payload: { method: PaymentMethod; accountNumber: string; amount: number }
): Promise<void> {
  const wdId = `w_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const path = `withdrawals/${wdId}`;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'withdrawals', wdId), {
      id: wdId,
      userId: wallet.userId,
      method: payload.method,
      accountNumber: payload.accountNumber.trim().slice(0, 30),
      amount: Number(payload.amount),
      status: 'pending',
      timestampLabel: formatNowLabel(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'user_wallets', wallet.userId), {
      balance: wallet.balance - Number(payload.amount),
      lastWithdrawalId: wdId,
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

// ==================== ADMIN MUTATIONS ====================

export async function approveDepositInDb(dep: DepositRequest): Promise<void> {
  const path = `deposits/${dep.id}`;
  try {
    await runTransaction(db, async (tx) => {
      const depRef = doc(db, 'deposits', dep.id);
      const walletRef = doc(db, 'user_wallets', dep.userId);
      const [depSnap, walletSnap] = await Promise.all([tx.get(depRef), tx.get(walletRef)]);

      if (!depSnap.exists() || depSnap.data().status !== 'pending') return;

      tx.update(depRef, {
        status: 'approved',
        updatedAt: serverTimestamp(),
      });

      if (walletSnap.exists()) {
        const currentBal = Number(walletSnap.data().balance ?? 0);
        tx.update(walletRef, {
          balance: currentBal + Number(dep.amount),
          updatedAt: serverTimestamp(),
        });
      }
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function rejectDepositInDb(depId: string): Promise<void> {
  const path = `deposits/${depId}`;
  try {
    await updateDoc(doc(db, 'deposits', depId), {
      status: 'rejected',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function approveSubmissionInDb(
  sub: TaskSubmission,
  fallbackReward: number
): Promise<void> {
  const path = `submissions/${sub.id}`;
  try {
    await runTransaction(db, async (tx) => {
      const subRef = doc(db, 'submissions', sub.id);
      const walletRef = doc(db, 'user_wallets', sub.userId);
      const [subSnap, walletSnap] = await Promise.all([tx.get(subRef), tx.get(walletRef)]);

      if (!subSnap.exists() || subSnap.data().status !== 'pending') return;

      const reward = Number(subSnap.data().rewardSnapshot ?? fallbackReward);
      tx.update(subRef, {
        status: 'approved',
        updatedAt: serverTimestamp(),
      });

      if (walletSnap.exists()) {
        const currentBal = Number(walletSnap.data().balance ?? 0);
        tx.update(walletRef, {
          balance: currentBal + reward,
          updatedAt: serverTimestamp(),
        });
      }
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function rejectSubmissionInDb(subId: string): Promise<void> {
  const path = `submissions/${subId}`;
  try {
    await updateDoc(doc(db, 'submissions', subId), {
      status: 'rejected',
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updatePackageInDb(pkg: PremiumPackage): Promise<void> {
  const path = `premium_packages/${pkg.id}`;
  try {
    await setDoc(
      doc(db, 'premium_packages', pkg.id),
      {
        id: pkg.id,
        tier: pkg.tier,
        name: pkg.name.trim().slice(0, 100),
        price: Number(pkg.price),
        dailyIncome: Number(pkg.dailyIncome),
        durationDays: Number(pkg.durationDays),
        description: pkg.description.trim().slice(0, 500),
        visibility: 'public',
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function addTaskInDb(task: Omit<Task, 'id'>): Promise<void> {
  const taskId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const path = `tasks/${taskId}`;
  try {
    await setDoc(doc(db, 'tasks', taskId), {
      id: taskId,
      title: task.title.trim().slice(0, 150),
      desc: task.desc.trim().slice(0, 1000),
      target: task.target.trim().slice(0, 100),
      reward: Number(task.reward),
      isPremium: Boolean(task.isPremium),
      requiredTier: task.isPremium ? task.requiredTier || 'silver' : 'none',
      durationDays: Number(task.durationDays || 30),
      isActive: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateTaskInDb(task: Task): Promise<void> {
  const path = `tasks/${task.id}`;
  try {
    await updateDoc(doc(db, 'tasks', task.id), {
      title: task.title.trim().slice(0, 150),
      desc: task.desc.trim().slice(0, 1000),
      target: task.target.trim().slice(0, 100),
      reward: Number(task.reward),
      isPremium: Boolean(task.isPremium),
      requiredTier: task.isPremium ? task.requiredTier || 'silver' : 'none',
      durationDays: Number(task.durationDays || 30),
      isActive: Boolean(task.isActive ?? true),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteTaskInDb(taskId: string): Promise<void> {
  const path = `tasks/${taskId}`;
  try {
    await deleteDoc(doc(db, 'tasks', taskId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function deletePostInDb(postId: string): Promise<void> {
  const path = `posts/${postId}`;
  try {
    await deleteDoc(doc(db, 'posts', postId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function savePublicSettingsInDb(
  paymentNumbers: PaymentNumbers,
  minPremiumRate: number
): Promise<void> {
  const path = 'app_settings/public';
  try {
    await setDoc(doc(db, 'app_settings', 'public'), {
      bKash: paymentNumbers.bKash.trim().slice(0, 30),
      Nagad: paymentNumbers.Nagad.trim().slice(0, 30),
      Rocket: paymentNumbers.Rocket.trim().slice(0, 30),
      minPremiumRate: Number(minPremiumRate),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function saveAdminPinHashInDb(adminPinHash: string): Promise<void> {
  const path = 'admin_secrets/passcode';
  try {
    await setDoc(doc(db, 'admin_secrets', 'passcode'), {
      adminPinHash,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
