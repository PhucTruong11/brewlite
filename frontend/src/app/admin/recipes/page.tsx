'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import { AlertCircle, BookOpen, Lock, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import api from '@/lib/api';

type Size = 'S' | 'M' | 'L';
type IngredientUnit = 'G' | 'ML' | 'PIECE';

interface Product {
  id: string;
  name: string;
  isAvailable: boolean;
  prices: { size: Size }[];
}

interface Topping {
  id: string;
  name: string;
  isAvailable: boolean;
}

interface Ingredient {
  id: string;
  code: string;
  name: string;
  unit: IngredientUnit;
  trackStock: boolean;
  isActive: boolean;
}

interface RecipeLine {
  ingredientId: string;
  quantity: string | number;
}

interface DraftLine {
  key: number;
  ingredientId: string;
  quantity: string;
}

interface RecipePayload {
  ingredients: { ingredientId: string; quantity: number }[];
  expectedIngredients: { ingredientId: string; quantity: number }[];
}

interface ProductTarget {
  id: string;
  size: Size;
  name: string;
}

const SIZE_ORDER: Size[] = ['S', 'M', 'L'];
// Nguyên liệu chính bắt buộc của mọi công thức đồ uống (khớp quy tắc backend)
const REQUIRED_MAIN_CODES: string[] = ['WATER', 'ICE'];
const FIELD_CLASS = 'w-full rounded-xl border border-primary/20 bg-white px-3 py-2.5 text-sm text-text outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:cursor-not-allowed disabled:bg-background';

// Bao bì nhận diện theo mã, giống backend: ly các size và ống hút.
function isPackagingCode(code: string): boolean {
  return code.startsWith('CUP_') || code === 'STRAW';
}

function messageFromError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (!error.response) return 'Không kết nối được với API. Vui lòng thử lại.';
    const message: unknown = error.response.data?.message;
    if (Array.isArray(message)) return message.map(String).join('. ');
    if (typeof message === 'string') return message;
  }
  return 'Có lỗi xảy ra. Vui lòng thử lại.';
}

function unitLabel(unit: IngredientUnit): string {
  return unit === 'G' ? 'g' : unit === 'ML' ? 'ml' : 'cái';
}

// Chuyển các dòng công thức về dạng gửi lên API
function toApiLines(lines: RecipeLine[]) {
  return lines.map((line) => ({ ingredientId: line.ingredientId, quantity: Number(line.quantity) }));
}

function validateLines(lines: DraftLine[], ingredients: Ingredient[]): string | null {
  if (lines.length === 0) return 'Công thức cần ít nhất một nguyên liệu.';
  const ids = new Set<string>();
  for (const line of lines) {
    if (!line.ingredientId) return 'Hãy chọn nguyên liệu cho mọi dòng.';
    if (ids.has(line.ingredientId)) return 'Một nguyên liệu chỉ được xuất hiện một lần trong công thức.';
    ids.add(line.ingredientId);
    const ingredient = ingredients.find((entry) => entry.id === line.ingredientId);
    if (!ingredient) return 'Có nguyên liệu không còn trong danh mục.';
    if (!ingredient.isActive) return `Nguyên liệu ${ingredient.name} đã ngừng sử dụng.`;
    const value = line.quantity.trim();
    if (!/^\d+(?:\.\d{1,3})?$/.test(value) || Number(value) <= 0) {
      return `Định lượng của ${ingredient.name} phải lớn hơn 0 và có tối đa 3 chữ số thập phân.`;
    }
    if (ingredient.unit === 'PIECE' && !Number.isInteger(Number(value))) {
      return `Định lượng của ${ingredient.name} phải là số nguyên.`;
    }
  }
  return null;
}

/* ───────────── Công thức đồ uống theo size ───────────── */

function RecipeEditor({
  target,
  ingredients,
  onDirtyChange,
}: {
  target: ProductTarget;
  ingredients: Ingredient[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DraftLine[] | null>(null);
  // Bản công thức gốc, đóng băng lúc bắt đầu sửa; dữ liệu tải mới về không được làm đổi nó
  const [baseline, setBaseline] = useState<RecipeLine[] | null>(null);
  const [conflict, setConflict] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nextKey, setNextKey] = useState(1);
  const [picking, setPicking] = useState(false);
  const [pickId, setPickId] = useState('');
  const queryKey = ['admin-recipe', 'product', target.id, target.size] as const;

  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  // Ly đúng size và ống hút: cố định 1 cái cho mỗi ly đồ uống (quy tắc của backend)
  const cup = ingredients.find((ingredient) => ingredient.code === `CUP_${target.size}`);
  const straw = ingredients.find((ingredient) => ingredient.code === 'STRAW');
  const requiredNames = REQUIRED_MAIN_CODES
    .map((code) => ingredients.find((ingredient) => ingredient.code === code)?.name ?? code)
    .join(', ');

  const recipeQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await api.get<{ data: RecipeLine[] }>('/admin/recipes', {
        params: { productId: target.id, size: target.size },
      });
      if (!Array.isArray(response.data.data)) throw new Error('Dữ liệu công thức không hợp lệ.');
      return response.data.data;
    },
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0, // không dùng lại cache cũ làm bản gốc khi quay lại công thức này
  });

  const savedLines = recipeQuery.data ?? [];
  const originalLines = baseline ?? savedLines; // toàn bộ dòng của bản gốc, gửi làm expectedIngredients
  // Ly và ống hút không nằm trong phần chỉnh sửa
  const isPackagingLine = (line: RecipeLine) => isPackagingCode(ingredientById.get(line.ingredientId)?.code ?? '');
  const toDraft = (source: RecipeLine[]): DraftLine[] => source
    .filter((line) => !isPackagingLine(line))
    .map((line, index) => ({ key: index + 1, ingredientId: line.ingredientId, quantity: String(line.quantity) }));

  const lines: DraftLine[] = draft ?? toDraft(savedLines);
  const originalMain = originalLines
    .filter((line) => !isPackagingLine(line))
    .map((line) => [line.ingredientId, Number(line.quantity)]);
  // So sánh theo số để "48" và "48.000" không bị coi là khác nhau
  const isDirty = draft !== null &&
    JSON.stringify(draft.map((line) => [line.ingredientId, Number(line.quantity)])) !== JSON.stringify(originalMain);
  const canEdit = recipeQuery.isSuccess && ingredients.length > 0;

  const isRequiredLine = (ingredientId: string) => REQUIRED_MAIN_CODES.includes(ingredientById.get(ingredientId)?.code ?? '');
  // Nguyên liệu chính có thể thêm: đang sử dụng, không phải bao bì, chưa có trong công thức
  const addable = ingredients.filter((ingredient) =>
    ingredient.isActive && !isPackagingCode(ingredient.code) && !lines.some((line) => line.ingredientId === ingredient.id));

  // Báo cho trang cha để hỏi xác nhận khi chuyển sản phẩm hoặc size lúc còn bản sửa chưa lưu
  useEffect(() => {
    onDirtyChange(isDirty);
    return () => onDirtyChange(false);
  }, [isDirty, onDirtyChange]);

  const saveMutation = useMutation({
    mutationFn: async (payload: RecipePayload) => {
      // PUT thay toàn bộ công thức; expectedIngredients là bản gốc để backend phát hiện người khác đã lưu trước.
      await api.put(`/admin/recipes/products/${target.id}/${target.size}`, payload);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      // Số ly bán được của menu và nhãn sử dụng của nguyên liệu phụ thuộc công thức
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-ingredients'] });
      setDraft(null);
      setBaseline(null);
      setConflict(false);
      setFormError(null);
      setNotice(`Đã lưu công thức size ${target.size}. Đơn tạo sau thời điểm này sẽ dùng định lượng mới.`);
    },
    onError: (error) => {
      setNotice(null);
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        setConflict(true);
        setFormError('Công thức này vừa được người khác thay đổi. Bản sửa của bạn chưa được lưu. Hãy tải lại công thức mới nhất rồi nhập lại thay đổi.');
        return;
      }
      setFormError(messageFromError(error));
    },
  });

  // Mọi thay đổi đều đi qua đây để chụp bản gốc đúng một lần, ở lần sửa đầu tiên
  function changeDraft(next: DraftLine[]) {
    if (draft === null) setBaseline(savedLines);
    setDraft(next);
    setFormError(null);
    setNotice(null);
  }

  // Hoàn tác: bỏ bản sửa, quay về bản gốc đang hiển thị (không gọi mạng)
  function revert() {
    setDraft(null);
    setBaseline(null);
    setPicking(false);
    setPickId('');
    setFormError(null);
    setNotice(null);
  }

  // Dùng khi xung đột: bỏ bản sửa, tải công thức mới nhất rồi lấy nó làm bản gốc mới
  async function reloadRecipe() {
    const result = await recipeQuery.refetch();
    if (result.isError) {
      setFormError('Không tải lại được công thức. Vui lòng thử lại.');
      return;
    }
    revert();
    setConflict(false);
  }

  function updateQuantity(key: number, value: string) {
    changeDraft(lines.map((line) => (line.key === key ? { ...line, quantity: value } : line)));
  }

  function removeLine(key: number) {
    changeDraft(lines.filter((line) => line.key !== key));
  }

  // Size chưa có công thức: tạo sẵn các dòng bắt buộc để nhập định lượng
  function startNew() {
    const missing = REQUIRED_MAIN_CODES.filter((code) => !ingredients.some((ingredient) => ingredient.code === code && ingredient.isActive));
    if (missing.length > 0) {
      setFormError(`Danh mục thiếu nguyên liệu bắt buộc đang sử dụng: ${missing.join(', ')}. Hãy thêm hoặc bật lại ở trang Nguyên liệu.`);
      return;
    }
    const starter: DraftLine[] = REQUIRED_MAIN_CODES.map((code, index) => ({
      key: index + 1,
      ingredientId: ingredients.find((ingredient) => ingredient.code === code)!.id,
      quantity: '',
    }));
    changeDraft(starter);
    setNextKey(starter.length + 1);
  }

  function addPicked() {
    if (!pickId) {
      setFormError('Chọn một nguyên liệu để thêm.');
      return;
    }
    const key = Math.max(nextKey, ...lines.map((line) => line.key + 1));
    changeDraft([...lines, { key, ingredientId: pickId, quantity: '' }]);
    setNextKey(key + 1);
    setPickId('');
    setPicking(false);
  }

  function saveRecipe() {
    if (saveMutation.isPending) return; // chặn gửi lặp
    const error = validateLines(lines, ingredients);
    if (error) {
      setFormError(error);
      return;
    }
    const missingRequired = REQUIRED_MAIN_CODES.filter((code) =>
      !lines.some((line) => ingredientById.get(line.ingredientId)?.code === code));
    if (missingRequired.length > 0) {
      setFormError(`Công thức đồ uống bắt buộc có: ${requiredNames}.`);
      return;
    }
    if (!cup || !straw) {
      setFormError('Danh mục chưa có ly đúng size hoặc ống hút, không thể lưu công thức đồ uống.');
      return;
    }
    if (!cup.isActive || !straw.isActive) {
      setFormError('Ly đúng size hoặc ống hút đang ngừng sử dụng, không thể lưu công thức đồ uống.');
      return;
    }
    setFormError(null);
    setNotice(null);
    // Công thức đồ uống luôn kèm 1 ly đúng size và 1 ống hút
    const packagingPayload = [cup, straw].map((ingredient) => ({ ingredientId: ingredient.id, quantity: 1 }));
    saveMutation.mutate({
      ingredients: [
        ...lines.map((line) => ({ ingredientId: line.ingredientId, quantity: Number(line.quantity) })),
        ...packagingPayload,
      ],
      expectedIngredients: toApiLines(originalLines),
    });
  }

  return (
    <section className="min-w-0 rounded-2xl border border-primary/15 bg-surface p-4 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-primary/10 pb-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-primary">Nguyên liệu chính</p>
          <h2 className="mt-1 text-xl font-extrabold text-text">{target.name} · Size {target.size}</h2>
          <p className="mt-1 text-sm text-text/65">Mỗi size có công thức riêng: sửa size nào chỉ ảnh hưởng size đó. Định lượng tính cho một ly.</p>
        </div>
        {recipeQuery.isSuccess && lines.length > 0 && (
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${isDirty ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
            {isDirty ? 'Chưa lưu thay đổi' : 'Đã đồng bộ'}
          </span>
        )}
      </div>

      {recipeQuery.isPending ? (
        <div className="py-14 text-center text-sm text-text/60">Đang tải công thức...</div>
      ) : recipeQuery.isError ? (
        <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <div className="flex items-start gap-2"><AlertCircle className="mt-0.5 shrink-0" size={18} /><span>{messageFromError(recipeQuery.error)}</span></div>
          <button type="button" onClick={() => void recipeQuery.refetch()} className="mt-3 font-bold underline">Thử tải lại</button>
        </div>
      ) : (
        <>
          {lines.length === 0 ? (
            <div className="mt-5 rounded-xl border border-dashed border-primary/20 bg-background p-5 text-sm text-text/70">
              <p>Size {target.size} chưa có công thức nên khách chưa đặt được size này. Công thức mới gồm {requiredNames} (bắt buộc), bạn có thể thêm các nguyên liệu khác.</p>
              <button type="button" onClick={startNew} disabled={!canEdit} className="mt-3 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-white hover:bg-primary-hover disabled:opacity-50">
                <Plus size={17} /> Tạo công thức cho size này
              </button>
            </div>
          ) : (
            <>
              <div className="mt-5 space-y-3">
                {lines.map((line, index) => {
                  const selected = ingredientById.get(line.ingredientId);
                  const required = isRequiredLine(line.ingredientId);
                  return (
                    <div key={line.key} className="grid gap-3 rounded-xl border border-primary/10 bg-background p-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(110px,0.7fr)_auto] sm:items-end">
                      <div>
                        <p className="text-xs font-semibold text-text/70">Nguyên liệu {index + 1}</p>
                        <p className="mt-2 text-sm font-semibold text-text">
                          {selected?.name ?? 'Nguyên liệu không rõ'}
                          {required && <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">Bắt buộc</span>}
                          {selected && !selected.isActive && <span className="ml-2 text-xs font-medium text-red-600">đã ngừng sử dụng</span>}
                        </p>
                      </div>
                      <label className="block text-xs font-semibold text-text/70">
                        Định lượng / ly
                        <div className="relative mt-1">
                          <input type="number" inputMode="decimal" min={selected?.unit === 'PIECE' ? '1' : '0.001'} step={selected?.unit === 'PIECE' ? '1' : '0.001'} value={line.quantity} disabled={!canEdit || saveMutation.isPending} onChange={(event) => updateQuantity(line.key, event.target.value)} className={`${FIELD_CLASS} pr-12`} placeholder="0" />
                          <span className="absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-text/50">{selected ? unitLabel(selected.unit) : '—'}</span>
                        </div>
                      </label>
                      {required ? (
                        <span className="hidden h-10 w-10 sm:block" aria-hidden="true" />
                      ) : (
                        <button type="button" aria-label={`Xóa nguyên liệu dòng ${index + 1}`} title="Xóa dòng" disabled={!canEdit || saveMutation.isPending} onClick={() => removeLine(line.key)} className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40">
                          <Trash2 size={17} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {picking ? (
                <div className="mt-4 flex flex-wrap items-end gap-2 rounded-xl border border-primary/15 bg-background p-3">
                  <label className="block min-w-[200px] flex-1 text-xs font-semibold text-text/70">
                    Chọn nguyên liệu trong kho
                    <select value={pickId} onChange={(event) => setPickId(event.target.value)} className={`${FIELD_CLASS} mt-1`}>
                      <option value="">Chọn nguyên liệu</option>
                      {addable.map((ingredient) => (
                        <option key={ingredient.id} value={ingredient.id}>{ingredient.name} ({unitLabel(ingredient.unit)})</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={addPicked} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-bold text-white hover:bg-primary-hover">Thêm</button>
                  <button type="button" onClick={() => { setPicking(false); setPickId(''); }} className="rounded-xl border border-primary/20 px-4 py-2.5 text-sm font-semibold text-text hover:bg-white">Hủy</button>
                </div>
              ) : (
                <button type="button" onClick={() => setPicking(true)} disabled={!canEdit || saveMutation.isPending || addable.length === 0} title={addable.length === 0 ? 'Đã thêm hết các nguyên liệu đang sử dụng' : undefined} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-primary/30 px-4 py-2.5 text-sm font-bold text-primary hover:bg-primary/5 disabled:opacity-50">
                  <Plus size={17} /> Thêm nguyên liệu
                </button>
              )}

              <div className="mt-6 rounded-xl border border-primary/10 bg-background p-4">
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-primary"><Lock size={14} /> Bao bì (cố định)</p>
                <p className="mt-1 text-xs text-text/60">Mỗi ly đồ uống dùng đúng 1 ly theo size và 1 ống hút. Giá trị này do hệ thống quy định nên không chỉnh được.</p>
                <ul className="mt-3 space-y-2 text-sm">
                  {[cup, straw].map((ingredient, index) => (
                    <li key={index} className="flex items-center justify-between rounded-lg bg-white px-3 py-2">
                      <span className="font-semibold text-text">{ingredient?.name ?? (index === 0 ? `Ly size ${target.size}` : 'Ống hút')}</span>
                      <span className="text-text/70">{ingredient ? '1 cái / ly' : 'Chưa có trong danh mục'}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-primary/10 pt-5">
                <p className="max-w-md text-xs leading-5 text-text/60">
                  Nước và đá nằm trong công thức dù nước không theo dõi tồn. Thay đổi chỉ áp dụng cho đơn tạo sau khi lưu.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={revert} disabled={!isDirty || saveMutation.isPending} className="inline-flex items-center gap-2 rounded-xl border border-primary/20 px-4 py-2.5 text-sm font-semibold text-text hover:bg-background disabled:opacity-40"><RotateCcw size={16} /> Hoàn tác</button>
                  <button type="button" onClick={saveRecipe} disabled={!canEdit || !isDirty || saveMutation.isPending || conflict} className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"><Save size={16} /> {saveMutation.isPending ? 'Đang lưu...' : 'Lưu công thức'}</button>
                </div>
              </div>
            </>
          )}

          {formError && (
            <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {formError}
              {conflict && <button type="button" onClick={() => void reloadRecipe()} disabled={recipeQuery.isFetching} className="mt-2 block font-bold underline disabled:opacity-50">Tải lại công thức mới nhất</button>}
            </div>
          )}
          {notice && <p role="status" className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
        </>
      )}
    </section>
  );
}

/* ───────────── Topping: nguyên liệu đi kèm ───────────── */

function ToppingRow({ topping, ingredients }: { topping: Topping; ingredients: Ingredient[] }) {
  const queryClient = useQueryClient();
  // Định lượng đang nhập (chuỗi); null nghĩa là chưa sửa
  const [draft, setDraft] = useState<string | null>(null);
  // Bản công thức gốc, đóng băng lúc bắt đầu sửa, gửi làm expectedIngredients
  const [baseline, setBaseline] = useState<RecipeLine[] | null>(null);
  const [conflict, setConflict] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryKey = ['admin-recipe', 'topping', topping.id, null] as const;

  const recipeQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await api.get<{ data: RecipeLine[] }>('/admin/recipes', { params: { toppingId: topping.id } });
      if (!Array.isArray(response.data.data)) throw new Error('Dữ liệu công thức không hợp lệ.');
      return response.data.data;
    },
    retry: false,
    refetchOnWindowFocus: false,
    gcTime: 0,
  });

  const savedLines = recipeQuery.data ?? [];
  const originalLines = baseline ?? savedLines;
  const single = savedLines.length === 1 ? savedLines[0] : null; // chỉ chỉnh được khi đúng một nguyên liệu
  const ingredient = single ? ingredients.find((entry) => entry.id === single.ingredientId) : undefined;
  const quantityText = draft ?? (single ? String(Number(single.quantity)) : '');
  const originalQuantity = originalLines.length === 1 ? Number(originalLines[0].quantity) : null;
  // So sánh theo số để "25" và "25.000" không bị coi là khác nhau
  const isDirty = draft !== null && originalQuantity !== null && Number(draft) !== originalQuantity;

  const saveMutation = useMutation({
    mutationFn: async (payload: RecipePayload) => {
      await api.put(`/admin/recipes/toppings/${topping.id}`, payload);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-ingredients'] });
      setDraft(null);
      setBaseline(null);
      setConflict(false);
      setFormError(null);
      setNotice('Đã lưu định lượng topping. Đơn tạo sau thời điểm này sẽ dùng định lượng mới.');
    },
    onError: (error) => {
      setNotice(null);
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        setConflict(true);
        setFormError('Định lượng topping này vừa được người khác thay đổi. Bản sửa của bạn chưa được lưu. Hãy tải lại rồi nhập lại.');
        return;
      }
      setFormError(messageFromError(error));
    },
  });

  function changeQuantity(value: string) {
    if (draft === null) setBaseline(savedLines);
    setDraft(value);
    setFormError(null);
    setNotice(null);
  }

  function revert() {
    setDraft(null);
    setBaseline(null);
    setFormError(null);
    setNotice(null);
  }

  async function reloadTopping() {
    const result = await recipeQuery.refetch();
    if (result.isError) {
      setFormError('Không tải lại được công thức topping. Vui lòng thử lại.');
      return;
    }
    revert();
    setConflict(false);
  }

  function saveTopping() {
    if (saveMutation.isPending || !single) return; // chặn gửi lặp
    const error = validateLines([{ key: 1, ingredientId: single.ingredientId, quantity: quantityText }], ingredients);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError(null);
    setNotice(null);
    // Giữ nguyên nguyên liệu, chỉ đổi định lượng một phần
    saveMutation.mutate({
      ingredients: [{ ingredientId: single.ingredientId, quantity: Number(quantityText) }],
      expectedIngredients: toApiLines(originalLines),
    });
  }

  const ingredientNames = savedLines.map((line) => ingredients.find((entry) => entry.id === line.ingredientId)?.name ?? 'Nguyên liệu không rõ').join(', ');

  return (
    <div className="rounded-xl border border-primary/10 bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-extrabold text-text">{topping.name}</p>
        {single && (
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${isDirty ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>
            {isDirty ? 'Chưa lưu thay đổi' : 'Đã đồng bộ'}
          </span>
        )}
      </div>

      {recipeQuery.isPending ? (
        <p className="mt-3 text-sm text-text/60">Đang tải...</p>
      ) : recipeQuery.isError ? (
        <div role="alert" className="mt-3 text-sm text-red-800">
          {messageFromError(recipeQuery.error)}{' '}
          <button type="button" onClick={() => void recipeQuery.refetch()} className="font-bold underline">Thử tải lại</button>
        </div>
      ) : savedLines.length === 0 ? (
        <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          Topping này chưa có nguyên liệu nào trong công thức nên khách chọn topping sẽ không đặt được. Trang này không chọn hay đổi nguyên liệu topping, hãy bổ sung dữ liệu trước (ví dụ chạy catalog:bootstrap trên DB chưa có công thức) rồi tải lại trang.
        </p>
      ) : savedLines.length > 1 ? (
        <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
          Topping này đang có {savedLines.length} nguyên liệu trong công thức ({ingredientNames}). Trang này chỉ chỉnh topping có đúng một nguyên liệu và không tự chọn hay xóa dòng nào. Hãy xử lý dữ liệu để còn một nguyên liệu rồi tải lại trang.
        </p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(110px,0.7fr)_auto] sm:items-end">
            <div>
              <p className="text-xs font-semibold text-text/70">Nguyên liệu đi kèm</p>
              <p className="mt-2 text-sm font-semibold text-text">
                {ingredient?.name ?? 'Nguyên liệu không rõ'}
                {ingredient && !ingredient.isActive && <span className="ml-2 text-xs font-medium text-red-600">đã ngừng sử dụng</span>}
              </p>
            </div>
            <label className="block text-xs font-semibold text-text/70">
              Định lượng / phần
              <div className="relative mt-1">
                <input type="number" inputMode="decimal" min={ingredient?.unit === 'PIECE' ? '1' : '0.001'} step={ingredient?.unit === 'PIECE' ? '1' : '0.001'} value={quantityText} disabled={saveMutation.isPending} onChange={(event) => changeQuantity(event.target.value)} className={`${FIELD_CLASS} pr-12`} placeholder="0" />
                <span className="absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-text/50">{ingredient ? unitLabel(ingredient.unit) : '—'}</span>
              </div>
            </label>
            <div className="flex gap-2">
              <button type="button" onClick={revert} disabled={!isDirty || saveMutation.isPending} className="inline-flex h-10 items-center gap-1 rounded-xl border border-primary/20 px-3 text-sm font-semibold text-text hover:bg-white disabled:opacity-40"><RotateCcw size={15} /> Hoàn tác</button>
              <button type="button" onClick={saveTopping} disabled={!isDirty || saveMutation.isPending || conflict} className="inline-flex h-10 items-center gap-1 rounded-xl bg-primary px-4 text-sm font-bold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"><Save size={15} /> {saveMutation.isPending ? 'Đang lưu...' : 'Lưu'}</button>
            </div>
          </div>

          {formError && (
            <div role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {formError}
              {conflict && <button type="button" onClick={() => void reloadTopping()} disabled={recipeQuery.isFetching} className="mt-1 block font-bold underline disabled:opacity-50">Tải lại định lượng mới nhất</button>}
            </div>
          )}
          {notice && <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
        </>
      )}
    </div>
  );
}

function ToppingSection({
  toppings,
  isPending,
  isError,
  onRetry,
  ingredients,
}: {
  toppings: Topping[];
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  ingredients: Ingredient[];
}) {
  return (
    <section className="rounded-2xl border border-primary/15 bg-surface p-4 shadow-sm sm:p-6">
      <p className="text-xs font-bold uppercase tracking-widest text-primary">Topping đi kèm</p>
      <p className="mt-1 text-sm text-text/65">
        Nguyên liệu dùng thêm khi khách chọn topping, tính theo một phần. Topping chỉ trừ kho khi khách chọn, không cộng vào nguyên liệu chính của món. Định lượng dùng chung cho mọi món có topping này; ở đây chỉ chỉnh định lượng, không đổi nguyên liệu.
      </p>
      <div className="mt-4 space-y-3">
        {isPending ? (
          <p className="text-sm text-text/60">Đang tải danh sách topping...</p>
        ) : isError ? (
          <p role="alert" className="text-sm text-red-700">Không tải được topping. <button type="button" onClick={onRetry} className="font-bold underline">Thử lại</button></p>
        ) : toppings.length === 0 ? (
          <p className="text-sm text-text/60">Chưa có topping đang kinh doanh.</p>
        ) : (
          toppings.map((topping) => <ToppingRow key={topping.id} topping={topping} ingredients={ingredients} />)
        )}
      </div>
    </section>
  );
}

/* ───────────── Trang chính ───────────── */

export default function AdminRecipesPage() {
  const [productId, setProductId] = useState('');
  const [size, setSize] = useState<Size>('S');
  // Công thức đồ uống đang có bản sửa chưa lưu (do RecipeEditor báo lên)
  const [dirty, setDirty] = useState(false);

  // Đổi sản phẩm hoặc size sẽ làm mất bản sửa chưa lưu nên hỏi xác nhận
  function confirmLeaveProduct() {
    return !dirty || window.confirm('Công thức đang sửa chưa được lưu. Chuyển sang mục khác sẽ mất thay đổi. Tiếp tục?');
  }

  const productsQuery = useQuery({
    queryKey: ['admin-recipe-products'],
    queryFn: async () => (await api.get<{ data: Product[] }>('/admin/products')).data.data,
    retry: false,
  });
  const toppingsQuery = useQuery({
    queryKey: ['admin-recipe-toppings'],
    queryFn: async () => (await api.get<{ data: Topping[] }>('/products/toppings')).data.data,
    retry: false,
  });
  const ingredientsQuery = useQuery({
    queryKey: ['admin-ingredients'],
    queryFn: async () => (await api.get<{ data: Ingredient[] }>('/admin/ingredients')).data.data,
    retry: false,
  });

  const products = (productsQuery.data ?? []).filter((product) => product.isAvailable);
  const toppings = (toppingsQuery.data ?? []).filter((topping) => topping.isAvailable);
  const selectedProduct = products.find((product) => product.id === productId) ?? products[0];
  const sizes = selectedProduct?.prices.map((price) => price.size).filter((item): item is Size => SIZE_ORDER.includes(item)) ?? [];
  const selectedSize = sizes.includes(size) ? size : (sizes[0] ?? 'S');
  const target: ProductTarget | null = selectedProduct && sizes.length > 0
    ? { id: selectedProduct.id, size: selectedSize, name: selectedProduct.name }
    : null;
  const ingredients = ingredientsQuery.data ?? [];

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 lg:px-8">
      <div className="flex items-center gap-3">
        <span className="rounded-2xl bg-primary/10 p-3 text-primary"><BookOpen size={25} /></span>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-text">Công thức</h1>
          <p className="mt-1 text-sm text-text/65">Định lượng nguyên liệu cho từng size đồ uống và từng phần topping.</p>
        </div>
      </div>

      <div className="mt-5 rounded-2xl border border-primary/15 bg-primary/5 px-4 py-3 text-sm text-text/70">
        Công thức thay đổi chỉ áp dụng cho đơn được tạo sau khi lưu. Đơn đã tạo giữ nguyên định lượng tại thời điểm đặt.
      </div>

      <div className="mt-6 grid gap-4 rounded-2xl border border-primary/15 bg-surface p-4 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:p-5">
        <div>
          <label className="block text-sm font-semibold text-text">Sản phẩm
            <select value={selectedProduct?.id ?? ''} onChange={(event) => { if (!confirmLeaveProduct()) return; setProductId(event.target.value); setSize('S'); }} disabled={productsQuery.isPending || productsQuery.isError || products.length === 0} className={`${FIELD_CLASS} mt-2`}>
              {products.length === 0 && <option value="">Chưa có sản phẩm</option>}
              {products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}
            </select>
          </label>
          {productsQuery.isError && <p role="alert" className="mt-2 text-xs text-red-700">Không tải được sản phẩm. <button type="button" onClick={() => void productsQuery.refetch()} className="font-bold underline">Thử lại</button></p>}
        </div>
        {selectedProduct && (
          <div>
            <p className="text-sm font-semibold text-text">Kích cỡ</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {SIZE_ORDER.filter((item) => sizes.includes(item)).map((item) => (
                <button key={item} type="button" onClick={() => { if (item !== selectedSize && confirmLeaveProduct()) setSize(item); }} className={`h-10 min-w-10 rounded-xl border px-3 text-sm font-bold ${selectedSize === item ? 'border-primary bg-primary text-white' : 'border-primary/20 bg-white text-text hover:border-primary'}`}>{item}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-5 space-y-5">
        {ingredientsQuery.isPending ? (
          <div className="rounded-2xl border border-primary/15 bg-surface p-8 text-sm text-text/60">Đang tải danh mục nguyên liệu...</div>
        ) : ingredientsQuery.isError ? (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
            <div className="flex items-start gap-2"><AlertCircle className="mt-0.5 shrink-0" size={18} /><span>{messageFromError(ingredientsQuery.error)} Trang công thức cần danh mục nguyên liệu để chỉnh sửa.</span></div>
            <button type="button" onClick={() => void ingredientsQuery.refetch()} className="mt-3 font-bold underline">Thử tải lại</button>
          </div>
        ) : (
          <>
            {target ? (
              <RecipeEditor key={`${target.id}:${target.size}`} target={target} ingredients={ingredients} onDirtyChange={setDirty} />
            ) : (
              <div className="rounded-2xl border border-dashed border-primary/20 bg-surface p-8 text-sm text-text/60">Chưa có sản phẩm hoặc size đang kinh doanh để chọn.</div>
            )}
            <ToppingSection
              toppings={toppings}
              isPending={toppingsQuery.isPending}
              isError={toppingsQuery.isError}
              onRetry={() => void toppingsQuery.refetch()}
              ingredients={ingredients}
            />
          </>
        )}
      </div>
    </main>
  );
}