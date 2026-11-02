'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { AlertTriangle, CheckCircle2, PackagePlus, Pencil, Plus, Search, X } from 'lucide-react';
import api from '@/lib/api';

type IngredientUnit = 'G' | 'ML' | 'PIECE';
type DecimalValue = string | number | null;
type StockStatus = 'ok' | 'low' | 'out' | 'untracked';
type StockFilter = 'all' | StockStatus;
type ActiveFilter = 'all' | 'active' | 'inactive';
type UsageKey = 'drink' | 'topping' | 'packaging' | 'unused';
type UsageFilter = 'all' | UsageKey;

interface IngredientUsage {
  drink: boolean;
  topping: boolean;
  packaging: boolean;
  unused: boolean;
}

interface Ingredient {
  id: string;
  code: string;
  name: string;
  unit: IngredientUnit;
  trackStock: boolean;
  onHand: DecimalValue;
  reserved: DecimalValue;
  packageQuantity: DecimalValue;
  lowStockThreshold: DecimalValue;
  version: number;
  isActive: boolean;
  usage?: IngredientUsage;
}

const MAX_AMOUNT = 99_999_999_999.999;
const REFRESH_INTERVAL_MS = 10_000; // tự lấy dữ liệu mới mỗi 10 giây khi tab đang hiển thị
const UNIT_LABEL: Record<IngredientUnit, string> = { G: 'g', ML: 'ml', PIECE: 'cái' };
const UNIT_OPTIONS: { value: IngredientUnit; label: string }[] = [
  { value: 'G', label: 'Gram (g)' },
  { value: 'ML', label: 'Mililít (ml)' },
  { value: 'PIECE', label: 'Cái' },
];
const USAGE_LABEL: Record<UsageKey, string> = {
  drink: 'Đồ uống',
  topping: 'Topping',
  packaging: 'Bao bì',
  unused: 'Chưa dùng',
};
const STOCK_BADGE: Record<StockStatus, { label: string; className: string }> = {
  ok: { label: 'Đủ hàng', className: 'bg-emerald-100 text-emerald-700' },
  low: { label: 'Sắp hết', className: 'bg-amber-100 text-amber-800' },
  out: { label: 'Hết hàng', className: 'bg-red-100 text-red-700' },
  untracked: { label: 'Không theo dõi', className: 'bg-blue-100 text-blue-800' },
};
const INPUT_CLASS = 'mt-1 w-full rounded-xl border border-primary/20 bg-white px-3 py-2.5 text-sm text-text outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:bg-background disabled:text-text/40';
const SELECT_CLASS = 'rounded-xl border border-primary/15 bg-background px-3 py-2.5 text-sm outline-none focus:border-primary';

function amount(value: DecimalValue): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(value);
}

function formatAmount(value: number | null, unit: IngredientUnit): string {
  if (value === null) return '—';
  return `${formatNumber(value)} ${UNIT_LABEL[unit]}`;
}

// Lượng còn dùng được = tồn kho - đang giữ; null khi nguyên liệu không theo dõi tồn.
function availableOf(ingredient: Ingredient): number | null {
  if (!ingredient.trackStock) return null;
  const diff = (amount(ingredient.onHand) ?? 0) - (amount(ingredient.reserved) ?? 0);
  return Math.round(diff * 1000) / 1000;
}

// Hết hàng: không còn lượng dùng được. Sắp hết: còn hàng nhưng không vượt ngưỡng cảnh báo (nếu có đặt).
function stockStatus(ingredient: Ingredient): StockStatus {
  const available = availableOf(ingredient);
  if (available === null) return 'untracked';
  if (available <= 0) return 'out';
  const threshold = amount(ingredient.lowStockThreshold);
  if (threshold !== null && available <= threshold) return 'low';
  return 'ok';
}

type ParsedAmount = { value: number } | { error: string };

// Kiểm tra số nhập từ ô input theo đúng quy tắc Decimal(14, 3) của backend.
function parseAmount(text: string, unit: IngredientUnit, allowZero: boolean): ParsedAmount {
  const trimmed = text.trim();
  const value = Number(trimmed);
  if (!trimmed || !Number.isFinite(value)) return { error: 'Nhập một số hợp lệ' };
  if (allowZero ? value < 0 : value <= 0) return { error: allowZero ? 'Không được âm' : 'Phải lớn hơn 0' };
  if (Math.abs(value * 1000 - Math.round(value * 1000)) > 0.000001) return { error: 'Tối đa 3 chữ số thập phân' };
  if (unit === 'PIECE' && !Number.isInteger(value)) return { error: 'Đơn vị cái phải là số nguyên' };
  if (value > MAX_AMOUNT) return { error: 'Vượt giới hạn lưu trữ' };
  return { value };
}

function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return 'Không kết nối được máy chủ. Vui lòng thử lại sau.';
    const message = error.response.data?.message;
    if (Array.isArray(message)) return message.join('. ');
    if (typeof message === 'string') return message;
  }
  return 'Không thực hiện được thao tác. Vui lòng thử lại.';
}

async function fetchIngredients(): Promise<Ingredient[]> {
  const response = await api.get<{ data: Ingredient[] }>('/admin/ingredients');
  if (!Array.isArray(response.data.data)) throw new Error('Dữ liệu nguyên liệu không đúng định dạng.');
  return response.data.data;
}

function Field({ label, error, className = '', children }: { label: string; error?: string; className?: string; children: ReactNode }) {
  return (
    <label className={`block text-xs font-semibold text-text/70 ${className}`}>
      {label}
      {children}
      {error && <span role="alert" className="mt-1 block text-[11px] font-medium text-red-600">{error}</span>}
    </label>
  );
}

// Hộp thoại dùng chung; không đóng khi bấm nền để tránh mất dữ liệu đang nhập.
function Modal({ title, description, onClose, closable = true, children }: {
  title: string;
  description?: string;
  onClose: () => void;
  closable?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closable) onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [closable, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-3xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-primary/10 px-5 py-4">
          <div>
            <h2 className="text-lg font-extrabold text-text">{title}</h2>
            {description && <p className="mt-1 text-sm text-text/60">{description}</p>}
          </div>
          <button type="button" onClick={onClose} disabled={!closable} aria-label="Đóng" className="rounded-lg p-1 text-text/50 hover:bg-background disabled:opacity-40"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* ───────────── Thêm một nguyên liệu ───────────── */

type CreateField = 'code' | 'name' | 'onHand' | 'packageQuantity' | 'lowStockThreshold';
type CreateErrors = Partial<Record<CreateField, string>>;

interface CreateForm {
  code: string;
  name: string;
  unit: IngredientUnit;
  trackStock: boolean;
  onHand: string;
  packageQuantity: string;
  lowStockThreshold: string;
  isActive: boolean;
}

interface CreatePayload {
  code: string;
  name: string;
  unit: IngredientUnit;
  trackStock: boolean;
  onHand: number | null;
  packageQuantity: number | null;
  lowStockThreshold: number | null;
  isActive: boolean;
}

const EMPTY_CREATE_FORM: CreateForm = {
  code: '', name: '', unit: 'G', trackStock: true, onHand: '0', packageQuantity: '', lowStockThreshold: '', isActive: true,
};

// Kiểm tra trước ở client, cùng quy tắc với backend; backend vẫn kiểm tra lại.
function validateCreate(form: CreateForm) {
  const errors: CreateErrors = {};

  const code = form.code.trim().toUpperCase();
  if (!/^[A-Z0-9_]{2,40}$/.test(code)) errors.code = 'Mã 2–40 ký tự: chữ không dấu, số, dấu _';

  const name = form.name.trim();
  if (!name) errors.name = 'Nhập tên nguyên liệu';
  else if (name.length > 120) errors.name = 'Tối đa 120 ký tự';

  let onHand: number | null = null;
  if (form.trackStock) {
    const parsed = parseAmount(form.onHand, form.unit, true);
    if ('error' in parsed) errors.onHand = parsed.error;
    else onHand = parsed.value;
  }

  let packageQuantity: number | null = null;
  if (form.packageQuantity.trim()) {
    const parsed = parseAmount(form.packageQuantity, form.unit, false);
    if ('error' in parsed) errors.packageQuantity = parsed.error;
    else packageQuantity = parsed.value;
  }

  let lowStockThreshold: number | null = null;
  if (form.trackStock && form.lowStockThreshold.trim()) {
    const parsed = parseAmount(form.lowStockThreshold, form.unit, true);
    if ('error' in parsed) errors.lowStockThreshold = parsed.error;
    else lowStockThreshold = parsed.value;
  }

  const payload: CreatePayload = {
    code, name, unit: form.unit, trackStock: form.trackStock, onHand, packageQuantity, lowStockThreshold, isActive: form.isActive,
  };
  return { errors, payload, valid: Object.keys(errors).length === 0 };
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [errors, setErrors] = useState<CreateErrors>({});
  const [globalError, setGlobalError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async (payload: CreatePayload) =>
      api.post<{ data: Ingredient }>('/admin/ingredients', payload),
    onSuccess: async (response) => {
      // Làm mới danh sách ngay, không đợi chu kỳ 10 giây
      await queryClient.invalidateQueries({ queryKey: ['admin-ingredients'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onCreated(response.data.data.name);
    },
    onError: (error) => {
      // Giữ nguyên dữ liệu đã nhập, chỉ hiển thị lỗi
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        setErrors({ code: 'Mã nguyên liệu đã tồn tại' });
        setGlobalError(null);
        return;
      }
      setGlobalError(getErrorMessage(error));
    },
  });

  const pending = createMutation.isPending;
  const hasContent = !!form.code.trim() || !!form.name.trim();
  const step = form.unit === 'PIECE' ? '1' : '0.001';
  const unit = UNIT_LABEL[form.unit];

  const requestClose = useCallback(() => {
    if (pending) return;
    if (hasContent && !window.confirm('Bỏ thông tin đã nhập?')) return;
    onClose();
  }, [pending, hasContent, onClose]);

  function updateForm(patch: Partial<CreateForm>) {
    setForm((current) => ({ ...current, ...patch }));
    // Sửa ô nào thì xóa lỗi của ô đó
    setErrors((current) => {
      const next = { ...current };
      for (const field of Object.keys(patch)) delete next[field as CreateField];
      return next;
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return; // chặn gửi lặp

    const result = validateCreate(form);
    setErrors(result.errors);
    if (!result.valid) {
      setGlobalError('Có thông tin chưa hợp lệ. Kiểm tra các ô được đánh dấu rồi lưu lại.');
      return;
    }

    setGlobalError(null);
    createMutation.mutate(result.payload);
  }

  return (
    <Modal title="Thêm nguyên liệu" description="Mỗi lần thêm một nguyên liệu." onClose={requestClose} closable={!pending}>
      <form onSubmit={handleSubmit}>
        <div className="rounded-xl border border-primary/15 bg-primary/5 p-3 text-xs leading-5 text-text/70">
          <p><strong>Đơn vị cơ sở</strong>: đơn vị nhỏ nhất để tính tồn và công thức (g, ml hoặc cái).</p>
          <p><strong>Tồn ban đầu</strong>: lượng đang có trong kho, tính theo đơn vị cơ sở.</p>
          <p><strong>Quy cách đóng gói</strong>: một kiện chứa bao nhiêu đơn vị cơ sở. Chỉ là gợi ý khi nhập kho, không tự cộng vào tồn.</p>
          <p className="mt-1">Ví dụ: kiện cà phê 10 kg → đơn vị cơ sở là g, quy cách đóng gói là 10000. Đang có 2 kiện thì tồn ban đầu là 20000.</p>
        </div>

        {globalError && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{globalError}</p>}

        <fieldset disabled={pending} className="mt-4 min-w-0 border-0 p-0">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Mã nguyên liệu" error={errors.code}>
              <input value={form.code} maxLength={40} onChange={(event) => updateForm({ code: event.target.value.toUpperCase() })} className={`${INPUT_CLASS} uppercase`} placeholder="COFFEE_BEAN" autoFocus />
            </Field>
            <Field label="Tên nguyên liệu" error={errors.name}>
              <input value={form.name} maxLength={120} onChange={(event) => updateForm({ name: event.target.value })} className={INPUT_CLASS} placeholder="Hạt cà phê" />
            </Field>
            <Field label="Đơn vị cơ sở">
              <select value={form.unit} onChange={(event) => updateForm({ unit: event.target.value as IngredientUnit })} className={INPUT_CLASS}>
                {UNIT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field label={`Tồn ban đầu (${unit})`} error={errors.onHand}>
              <input type="number" inputMode="decimal" min="0" step={step} value={form.trackStock ? form.onHand : ''} disabled={!form.trackStock} onChange={(event) => updateForm({ onHand: event.target.value })} className={INPUT_CLASS} placeholder={form.trackStock ? '0' : 'Không theo dõi'} />
            </Field>
            <Field label={`Quy cách đóng gói (${unit} / kiện)`} error={errors.packageQuantity}>
              <input type="number" inputMode="decimal" min="0" step={step} value={form.packageQuantity} onChange={(event) => updateForm({ packageQuantity: event.target.value })} className={INPUT_CLASS} placeholder="Tùy chọn" />
            </Field>
            <Field label={`Cảnh báo khi còn dưới (${unit})`} error={errors.lowStockThreshold}>
              <input type="number" inputMode="decimal" min="0" step={step} value={form.trackStock ? form.lowStockThreshold : ''} disabled={!form.trackStock} onChange={(event) => updateForm({ lowStockThreshold: event.target.value })} className={INPUT_CLASS} placeholder="Tùy chọn" />
            </Field>
          </div>

          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-text">
              <input type="checkbox" checked={form.trackStock} onChange={(event) => updateForm({ trackStock: event.target.checked })} className="accent-primary" />
              Theo dõi tồn kho
            </label>
            <label className="flex items-center gap-2 text-sm font-medium text-text">
              <input type="checkbox" checked={form.isActive} onChange={(event) => updateForm({ isActive: event.target.checked })} className="accent-primary" />
              Đang sử dụng
            </label>
          </div>
        </fieldset>

        <div className="mt-5 flex justify-end gap-2 border-t border-primary/10 pt-4">
          <button type="button" onClick={requestClose} disabled={pending} className="rounded-xl border border-primary/20 px-4 py-2.5 text-sm font-semibold text-text hover:bg-background disabled:opacity-50">Hủy</button>
          <button type="submit" disabled={pending} className="rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover disabled:opacity-50">
            {pending ? 'Đang lưu...' : 'Lưu nguyên liệu'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────── Nhập kho ───────────── */

function RestockDialog({ ingredient, onClose, onDone }: { ingredient: Ingredient; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [quantityText, setQuantityText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const onHand = amount(ingredient.onHand) ?? 0;
  const reserved = amount(ingredient.reserved) ?? 0;
  const available = availableOf(ingredient) ?? 0;
  const packageQuantity = amount(ingredient.packageQuantity);
  const parsed = quantityText.trim() ? parseAmount(quantityText, ingredient.unit, false) : null;
  const expectedOnHand = parsed && 'value' in parsed ? Math.round((onHand + parsed.value) * 1000) / 1000 : null;

  const restockMutation = useMutation({
    mutationFn: async (quantity: number) =>
      api.post<{ data: Ingredient }>(`/admin/ingredients/${ingredient.id}/restock`, { quantity }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-ingredients'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onDone(`Đã nhập kho ${ingredient.name}.`);
    },
    onError: (error) => setFormError(getErrorMessage(error)),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (restockMutation.isPending) return;
    if (!parsed) return setFormError('Nhập số lượng cần nhập thêm.');
    if ('error' in parsed) return setFormError(`Số lượng nhập: ${parsed.error.toLowerCase()}.`);
    if (expectedOnHand !== null && expectedOnHand > MAX_AMOUNT) return setFormError('Tồn sau nhập vượt giới hạn lưu trữ.');
    setFormError(null);
    restockMutation.mutate(parsed.value);
  }

  return (
    <Modal title={`Nhập kho: ${ingredient.name}`} description={`Mã ${ingredient.code}`} onClose={onClose} closable={!restockMutation.isPending}>
      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-3 gap-2 rounded-xl bg-background p-3 text-center text-xs">
          <div><p className="text-text/60">Tồn hiện tại</p><p className="mt-1 font-bold text-text">{formatAmount(onHand, ingredient.unit)}</p></div>
          <div><p className="text-text/60">Đang giữ</p><p className="mt-1 font-bold text-text">{formatAmount(reserved, ingredient.unit)}</p></div>
          <div><p className="text-text/60">Có thể dùng</p><p className="mt-1 font-bold text-primary">{formatAmount(available, ingredient.unit)}</p></div>
        </div>

        {formError && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{formError}</p>}

        <label className="mt-4 block text-sm font-medium text-text">
          Số lượng bổ sung ({UNIT_LABEL[ingredient.unit]})
          <input type="number" inputMode="decimal" min="0" step={ingredient.unit === 'PIECE' ? '1' : '0.001'} value={quantityText} onChange={(event) => { setQuantityText(event.target.value); setFormError(null); }} className={INPUT_CLASS} placeholder={`Nhập số ${UNIT_LABEL[ingredient.unit]} cần cộng`} autoFocus />
        </label>
        <p className="mt-2 text-xs text-text/60">
          Số lượng tính theo đơn vị cơ sở ({UNIT_LABEL[ingredient.unit]}) và được cộng thẳng vào tồn kho.
          {packageQuantity !== null && (
            <> Một kiện = {formatAmount(packageQuantity, ingredient.unit)}.{' '}
              <button type="button" onClick={() => setQuantityText(String(Math.round(((Number(quantityText) || 0) + packageQuantity) * 1000) / 1000))} className="font-semibold text-primary underline underline-offset-2">Cộng thêm 1 kiện vào ô nhập</button>
            </>
          )}
        </p>

        <div className="mt-4 rounded-xl border border-primary/15 bg-primary/5 p-3 text-sm">
          <span className="text-text/70">Dự kiến tồn sau nhập: </span>
          <strong className="text-primary">{expectedOnHand === null ? '—' : formatAmount(expectedOnHand, ingredient.unit)}</strong>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={restockMutation.isPending} className="rounded-xl border border-primary/20 px-4 py-2.5 text-sm font-semibold text-text hover:bg-background disabled:opacity-50">Hủy</button>
          <button type="submit" disabled={restockMutation.isPending} className="rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover disabled:opacity-50">
            {restockMutation.isPending ? 'Đang lưu...' : 'Xác nhận nhập kho'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────── Sửa thông tin ───────────── */

function EditDialog({ ingredient, onClose, onSaved, onReload }: {
  ingredient: Ingredient;
  onClose: () => void;
  onSaved: (message: string) => void;
  onReload: () => Promise<Ingredient | undefined>;
}) {
  const queryClient = useQueryClient();
  const toText = (value: DecimalValue) => (value === null ? '' : String(value));
  // Version chụp lúc mở hộp thoại; chỉ đổi khi người dùng chủ động tải lại dữ liệu
  const [heldVersion, setHeldVersion] = useState(ingredient.version);
  const [name, setName] = useState(ingredient.name);
  const [packageQuantity, setPackageQuantity] = useState(toText(ingredient.packageQuantity));
  const [lowStockThreshold, setLowStockThreshold] = useState(toText(ingredient.lowStockThreshold));
  const [isActive, setIsActive] = useState(ingredient.isActive);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);

  const usedInRecipes = !!(ingredient.usage?.drink || ingredient.usage?.topping || ingredient.usage?.packaging) && !ingredient.usage?.unused;

  const updateMutation = useMutation({
    mutationFn: async (payload: { version: number; name: string; packageQuantity: number | null; lowStockThreshold?: number | null; isActive: boolean }) =>
      api.patch<{ data: Ingredient }>(`/admin/ingredients/${ingredient.id}`, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-ingredients'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      onSaved('Đã lưu thông tin nguyên liệu.');
    },
    onError: (error) => {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        setConflict(true);
        setFormError('Nguyên liệu này vừa được người khác cập nhật. Thay đổi của bạn chưa được lưu. Hãy tải lại dữ liệu mới nhất rồi nhập lại.');
        return;
      }
      setFormError(getErrorMessage(error));
    },
  });

  // Người dùng chủ động bỏ bản đang sửa và lấy dữ liệu (kèm version) mới nhất
  async function reload() {
    setReloading(true);
    const fresh = await onReload();
    setReloading(false);
    if (!fresh) return setFormError('Không tải lại được dữ liệu nguyên liệu. Vui lòng thử lại.');
    setHeldVersion(fresh.version);
    setName(fresh.name);
    setPackageQuantity(toText(fresh.packageQuantity));
    setLowStockThreshold(toText(fresh.lowStockThreshold));
    setIsActive(fresh.isActive);
    setConflict(false);
    setFormError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (updateMutation.isPending || conflict) return;
    if (!name.trim()) return setFormError('Tên nguyên liệu không được để trống.');

    let packageValue: number | null = null;
    if (packageQuantity.trim()) {
      const parsed = parseAmount(packageQuantity, ingredient.unit, false);
      if ('error' in parsed) return setFormError(`Quy cách nhập: ${parsed.error.toLowerCase()}.`);
      packageValue = parsed.value;
    }

    let thresholdValue: number | null = null;
    if (ingredient.trackStock && lowStockThreshold.trim()) {
      const parsed = parseAmount(lowStockThreshold, ingredient.unit, true);
      if ('error' in parsed) return setFormError(`Ngưỡng cảnh báo: ${parsed.error.toLowerCase()}.`);
      thresholdValue = parsed.value;
    }

    setFormError(null);
    updateMutation.mutate({
      version: heldVersion,
      name: name.trim(),
      packageQuantity: packageValue,
      // Nguyên liệu không theo dõi tồn không có ngưỡng cảnh báo nên không gửi trường này
      ...(ingredient.trackStock ? { lowStockThreshold: thresholdValue } : {}),
      isActive,
    });
  }

  const step = ingredient.unit === 'PIECE' ? '1' : '0.001';

  return (
    <Modal title={`Sửa nguyên liệu: ${ingredient.name}`} description={`Mã ${ingredient.code} · đơn vị ${UNIT_LABEL[ingredient.unit]}. Tồn kho không sửa ở đây, hãy dùng Nhập kho.`} onClose={onClose} closable={!updateMutation.isPending}>
      <form onSubmit={handleSubmit}>
        {formError && (
          <div role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {formError}
            {conflict && <button type="button" onClick={() => void reload()} disabled={reloading} className="mt-2 block font-bold underline disabled:opacity-50">{reloading ? 'Đang tải...' : 'Tải lại dữ liệu mới nhất'}</button>}
          </div>
        )}

        <label className="block text-sm font-medium text-text">
          Tên nguyên liệu
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} disabled={conflict} className={INPUT_CLASS} />
        </label>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-text">
            Quy cách nhập ({UNIT_LABEL[ingredient.unit]})
            <input type="number" inputMode="decimal" min="0" step={step} value={packageQuantity} onChange={(event) => setPackageQuantity(event.target.value)} disabled={conflict} className={INPUT_CLASS} placeholder="Không đặt" />
          </label>
          <label className="block text-sm font-medium text-text">
            Cảnh báo dưới ({UNIT_LABEL[ingredient.unit]})
            <input type="number" inputMode="decimal" min="0" step={step} value={lowStockThreshold} onChange={(event) => setLowStockThreshold(event.target.value)} disabled={conflict || !ingredient.trackStock} className={INPUT_CLASS} placeholder={ingredient.trackStock ? 'Không đặt' : 'Không theo dõi tồn'} />
          </label>
        </div>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm font-medium text-text">
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={conflict} className="accent-primary" />
          Đang sử dụng
        </label>
        {!isActive && ingredient.isActive && usedInRecipes && (
          <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
            Nguyên liệu này đang nằm trong công thức. Ngừng sử dụng sẽ khiến các món dùng nó không đặt được và không lưu được công thức mới có nguyên liệu này.
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={updateMutation.isPending} className="rounded-xl border border-primary/20 px-4 py-2.5 text-sm font-semibold text-text hover:bg-background disabled:opacity-50">Hủy</button>
          <button type="submit" disabled={updateMutation.isPending || conflict} className="rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover disabled:opacity-50">
            {updateMutation.isPending ? 'Đang lưu...' : 'Lưu thông tin'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────── Trang chính ───────────── */

export default function AdminIngredientsPage() {
  const [search, setSearch] = useState('');
  const [stockFilter, setStockFilter] = useState<StockFilter>('all');
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('all');
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [restockId, setRestockId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ['admin-ingredients'],
    queryFn: fetchIngredients,
    retry: 1,
    // Tự lấy dữ liệu mới khi tab đang hiển thị. Tải nền giữ nguyên bảng, không hiện trạng thái loading.
    refetchInterval: REFRESH_INTERVAL_MS,
  });
  const ingredients = useMemo(() => data ?? [], [data]);

  // Tự ẩn thông báo thành công sau vài giây
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const reloadIngredient = useCallback(async (id: string) => {
    const result = await refetch();
    return result.data?.find((ingredient) => ingredient.id === id);
  }, [refetch]);

  const restockTarget = ingredients.find((ingredient) => ingredient.id === restockId) ?? null;
  const editTarget = ingredients.find((ingredient) => ingredient.id === editId) ?? null;

  const visibleIngredients = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('vi-VN');
    return ingredients.filter((ingredient) => {
      if (keyword && !`${ingredient.name} ${ingredient.code}`.toLocaleLowerCase('vi-VN').includes(keyword)) return false;
      if (stockFilter !== 'all' && stockStatus(ingredient) !== stockFilter) return false;
      if (activeFilter === 'active' && !ingredient.isActive) return false;
      if (activeFilter === 'inactive' && ingredient.isActive) return false;
      if (usageFilter !== 'all' && !ingredient.usage?.[usageFilter]) return false;
      return true;
    });
  }, [ingredients, search, stockFilter, activeFilter, usageFilter]);

  const lowCount = ingredients.filter((ingredient) => stockStatus(ingredient) === 'low').length;
  const outCount = ingredients.filter((ingredient) => stockStatus(ingredient) === 'out').length;
  const hasFilters = !!search.trim() || stockFilter !== 'all' || activeFilter !== 'all' || usageFilter !== 'all';

  function clearFilters() {
    setSearch('');
    setStockFilter('all');
    setActiveFilter('all');
    setUsageFilter('all');
  }

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-14 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-text">Nguyên liệu</h1>
          <p className="mt-1 text-sm text-text/65">Quản lý tồn kho nguyên liệu: theo dõi lượng còn dùng được, nhập kho và đặt ngưỡng cảnh báo. Dữ liệu tự cập nhật mỗi 10 giây.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setShowCreate(true)} className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover">
            <Plus size={16} /> Thêm nguyên liệu
          </button>
        </div>
      </div>

      {notice && (
        <p role="status" className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">
          <CheckCircle2 size={16} className="shrink-0" /><span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Đóng thông báo"><X size={16} /></button>
        </p>
      )}

      {data && (
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-primary/10 bg-white p-4 shadow-sm"><p className="text-sm text-text/60">Tổng nguyên liệu</p><p className="mt-1 text-3xl font-extrabold text-primary">{ingredients.length}</p></div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm"><p className="text-sm text-amber-800">Sắp hết</p><p className="mt-1 text-3xl font-extrabold text-amber-800">{lowCount}</p></div>
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 shadow-sm"><p className="text-sm text-red-700">Hết hàng</p><p className="mt-1 text-3xl font-extrabold text-red-700">{outCount}</p></div>
        </div>
      )}

      <section className="mt-6 min-w-0" aria-label="Danh sách nguyên liệu">
        <div className="flex flex-col gap-3 lg:flex-row">
          <label className="relative flex-1">
            <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-text/45" />
            <span className="sr-only">Tìm nguyên liệu</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm theo tên hoặc mã..." className="w-full rounded-xl border border-primary/15 bg-white py-2.5 pl-10 pr-3 text-sm outline-none focus:border-primary" />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label><span className="sr-only">Lọc tình trạng tồn</span>
              <select value={stockFilter} onChange={(event) => setStockFilter(event.target.value as StockFilter)} className={`${SELECT_CLASS} w-full`}>
                <option value="all">Mọi tình trạng tồn</option>
                <option value="ok">Đủ hàng</option>
                <option value="low">Sắp hết</option>
                <option value="out">Hết hàng</option>
                <option value="untracked">Không theo dõi</option>
              </select>
            </label>
            <label><span className="sr-only">Lọc trạng thái sử dụng</span>
              <select value={activeFilter} onChange={(event) => setActiveFilter(event.target.value as ActiveFilter)} className={`${SELECT_CLASS} w-full`}>
                <option value="all">Mọi trạng thái</option>
                <option value="active">Đang sử dụng</option>
                <option value="inactive">Ngừng sử dụng</option>
              </select>
            </label>
            <label><span className="sr-only">Lọc cách sử dụng</span>
              <select value={usageFilter} onChange={(event) => setUsageFilter(event.target.value as UsageFilter)} className={`${SELECT_CLASS} w-full`}>
                <option value="all">Mọi cách sử dụng</option>
                {(Object.keys(USAGE_LABEL) as UsageKey[]).map((key) => <option key={key} value={key}>{USAGE_LABEL[key]}</option>)}
              </select>
            </label>
          </div>
        </div>

        {isPending ? (
          <p className="mt-4 rounded-2xl border border-primary/10 bg-white py-14 text-center text-sm text-text/60">Đang tải nguyên liệu...</p>
        ) : isError && !data ? (
          <div role="alert" className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
            <div className="flex items-center gap-2 font-bold"><AlertTriangle size={18} /> Chưa tải được danh sách nguyên liệu</div>
            <p className="mt-2">{getErrorMessage(error)}</p>
            <button type="button" onClick={() => void refetch()} className="mt-3 font-bold underline">Thử tải lại</button>
          </div>
        ) : ingredients.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-dashed border-primary/20 bg-white py-14 text-center text-sm text-text/60">
            Chưa có nguyên liệu nào trong hệ thống.
            <button type="button" onClick={() => setShowCreate(true)} className="ml-1 font-bold text-primary underline">Thêm nguyên liệu</button>
          </div>
        ) : visibleIngredients.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-primary/10 bg-white py-14 text-center text-sm text-text/60">
            Không có nguyên liệu phù hợp bộ lọc.
            {hasFilters && <button type="button" onClick={clearFilters} className="ml-1 font-bold text-primary underline">Xóa bộ lọc</button>}
          </div>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto rounded-2xl border border-primary/10 bg-white shadow-sm">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="border-b border-primary/10 bg-background text-xs uppercase text-text/60">
                  <tr>
                    <th className="px-4 py-3">Nguyên liệu</th>
                    <th className="px-3 py-3">Đơn vị</th>
                    <th className="px-3 py-3 text-right">Tồn kho</th>
                    <th className="px-3 py-3 text-right" title="Nguyên liệu dành cho đơn đang chờ thanh toán">Đang giữ *</th>
                    <th className="px-3 py-3 text-right">Có thể dùng</th>
                    <th className="px-3 py-3">Tình trạng</th>
                    <th className="px-3 py-3">Sử dụng</th>
                    <th className="px-4 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleIngredients.map((ingredient) => {
                    const status = stockStatus(ingredient);
                    const available = availableOf(ingredient);
                    const usageKeys = (Object.keys(USAGE_LABEL) as UsageKey[]).filter((key) => ingredient.usage?.[key]);
                    return (
                      <tr key={ingredient.id} className="border-b border-primary/5 last:border-0">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-text">{ingredient.name}</p>
                          <p className="text-xs text-text/55">{ingredient.code}</p>
                          {usageKeys.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {usageKeys.map((key) => <span key={key} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">{USAGE_LABEL[key]}</span>)}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-text/80">{UNIT_LABEL[ingredient.unit]}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{ingredient.trackStock ? formatNumber(amount(ingredient.onHand) ?? 0) : '—'}</td>
                        <td className="px-3 py-3 text-right tabular-nums">{ingredient.trackStock ? formatNumber(amount(ingredient.reserved) ?? 0) : '—'}</td>
                        <td className="px-3 py-3 text-right">
                          {available === null
                            ? <span className="text-xs font-semibold text-text/50">Không theo dõi</span>
                            : <span className="text-base font-extrabold tabular-nums text-primary">{formatNumber(available)}</span>}
                        </td>
                        <td className="px-3 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STOCK_BADGE[status].className}`}>{STOCK_BADGE[status].label}</span></td>
                        <td className="px-3 py-3"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ingredient.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>{ingredient.isActive ? 'Đang sử dụng' : 'Ngừng sử dụng'}</span></td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <button type="button" onClick={() => setRestockId(ingredient.id)} disabled={!ingredient.trackStock} title={ingredient.trackStock ? 'Nhập kho' : 'Nguyên liệu không theo dõi tồn'} className="inline-flex items-center gap-1 rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-40"><PackagePlus size={14} /> Nhập kho</button>
                            <button type="button" onClick={() => setEditId(ingredient.id)} className="inline-flex items-center gap-1 rounded-lg border border-primary/20 px-3 py-1.5 text-xs font-semibold text-text hover:bg-background"><Pencil size={14} /> Sửa</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-text/60">* Đang giữ: nguyên liệu dành cho các đơn đang chờ thanh toán. Có thể dùng = Tồn kho − Đang giữ. Số lượng tính theo đơn vị ở cột Đơn vị.</p>
          </>
        )}
      </section>

      {showCreate && (
        <CreateDialog
          onClose={() => setShowCreate(false)}
          onCreated={(name) => { setShowCreate(false); setNotice(`Đã tạo nguyên liệu ${name}.`); }}
        />
      )}
      {restockTarget && (
        <RestockDialog
          ingredient={restockTarget}
          onClose={() => setRestockId(null)}
          onDone={(message) => { setRestockId(null); setNotice(message); }}
        />
      )}
      {editTarget && (
        <EditDialog
          key={editTarget.id}
          ingredient={editTarget}
          onClose={() => setEditId(null)}
          onSaved={(message) => { setEditId(null); setNotice(message); }}
          onReload={() => reloadIngredient(editTarget.id)}
        />
      )}
    </main>
  );
}