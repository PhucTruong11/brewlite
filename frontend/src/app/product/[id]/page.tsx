'use client';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { useCartStore } from '@/stores/cart.store';
import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import { cartValidationMessage, validateCart } from '@/lib/validate-cart';

interface ProductPrice {
    id: string;
    size: 'S' | 'M' | 'L';
    price: number;
}

interface Product {
    id: string;
    name: string;
    description?: string;
    imageUrl?: string;
    category: string;
    allowToppings: boolean;
    stock?: number;
    stockBySize?: Record<string, number>;
    isAvailable?: boolean;
    prices: ProductPrice[];
}

interface Topping {
    id: string;
    name: string;
    price: number;
}

export default function ProductDetailPage() {
    const params = useParams();
    const router = useRouter();
    const productId = params?.id as string;

    const addItemToCart = useCartStore((s) => s.addItem);

    const [product, setProduct] = useState<Product | null>(null);
    const [toppingsList, setToppingsList] = useState<Topping[]>([]);
    const [loading, setLoading] = useState(true);

    const [selectedSize, setSelectedSize] = useState<'S' | 'M' | 'L'>('S');
    const [toppingQuantities, setToppingQuantities] = useState<{ [toppingId: string]: number }>({});
    const [quantity, setQuantity] = useState<number>(1);
    const [showSuccessModal, setShowSuccessModal] = useState(false);
    const [adding, setAdding] = useState(false);

    useEffect(() => {
        if (!productId) return;

        async function fetchData() {
            try {
                setLoading(true);
                const toppingsPromise = api
                    .get<ApiResponse<Topping[]>>('/products/toppings')
                    .then((res) => res.data.data)
                    .catch(() => [] as Topping[]);

                const resProd = await api.get<ApiResponse<Product>>(`/products/${productId}`);
                const dataProd: Product = resProd.data.data;
                setProduct(dataProd);

                if (dataProd?.prices && dataProd.prices.length > 0) {
                    setSelectedSize(dataProd.prices[0].size);
                }

                if (dataProd?.allowToppings) {
                    const toppings = await toppingsPromise;
                    if (Array.isArray(toppings)) {
                        setToppingsList(toppings);
                    }
                }
            } catch (err) {
                console.error('Lỗi tải dữ liệu:', err);
            } finally {
                setLoading(false);
            }
        }

        fetchData();
    }, [productId]);

    if (loading) {
        return (
            <div className="container mx-auto px-4 py-20 text-center text-base font-medium text-text/70">
                Đang tải thông tin sản phẩm...
            </div>
        );
    }

    if (!product) {
        return (
            <div className="container mx-auto px-4 py-20 text-center">
                <p className="text-xl font-bold text-text">Sản phẩm không tồn tại hoặc đã ngừng kinh doanh.</p>
                <Link href="/" className="mt-4 inline-block text-base font-bold text-primary hover:underline">
                    Quay lại trang chủ
                </Link>
            </div>
        );
    }

    const availableStock = product.stockBySize?.[selectedSize] ?? product.stock ?? 0;
    const isOutOfStock = availableStock <= 0 || product.isAvailable === false;

    const currentPriceObj = product.prices?.find((p) => p.size === selectedSize) || product.prices?.[0];
    const basePrice = currentPriceObj ? Number(currentPriceObj.price) || 0 : 0;

    const totalToppingPrice = Object.entries(toppingQuantities).reduce((sum, [topId, qty]) => {
        const topItem = toppingsList.find((t) => t.id === topId);
        return sum + (topItem ? (Number(topItem.price) || 0) * qty : 0);
    }, 0);

    const singleUnitPrice = basePrice + totalToppingPrice;
    const grandTotal = isOutOfStock ? 0 : singleUnitPrice * (quantity || 1);

    const handleToppingQtyChange = (topId: string, delta: number) => {
        if (isOutOfStock) return;
        setToppingQuantities((prev) => {
            const current = prev[topId] || 0;
            const updated = Math.max(0, current + delta);
            return { ...prev, [topId]: updated };
        });
    };

    const handleAddToCart = async () => {
        if (isOutOfStock) {
            alert('Sản phẩm này hiện đang tạm hết hàng, quý khách vui lòng chọn món khác nhé!');
            return;
        }

        const selectedToppingsSummary = Object.entries(toppingQuantities)
            .filter(([, qty]) => qty > 0)
            .map(([topId, qty]) => {
                const item = toppingsList.find((t) => t.id === topId);
                return {
                    id: topId,
                    name: item?.name || '',
                    price: Number(item?.price) || 0,
                    quantity: Number(qty) || 1,
                };
            });

        const validQty = Math.min(availableStock, Math.max(1, Number(quantity) || 1));

        const candidate = {
            productId: product.id,
            name: product.name,
            size: selectedSize,
            stock: availableStock,
            basePrice,
            toppings: selectedToppingsSummary,
            totalToppingPrice,
            unitPrice: singleUnitPrice,
            quantity: validQty,
            lineTotal: singleUnitPrice * validQty,
            imageUrl: product.imageUrl,
        };

        setAdding(true);
        try {
            const validation = await validateCart([...useCartStore.getState().items, candidate]);
            if (!validation.available) {
                alert(cartValidationMessage(validation));
                return;
            }
            const added = addItemToCart(candidate);

            if (!added) {
                alert('Không thể thêm món vào giỏ hàng.');
                return;
            }
            setShowSuccessModal(true);
        } catch {
            alert('Không kiểm tra được nguyên liệu. Vui lòng thử lại.');
        } finally {
            setAdding(false);
        }
    };

    const hasToppings = product.allowToppings && toppingsList.length > 0;

    return (
        <main className="container mx-auto max-w-5xl px-4 py-8">
            <nav className="mb-6 flex items-center gap-2 text-base text-text/60">
                <Link href="/" className="transition-colors hover:text-primary">
                    Trang chủ
                </Link>
                <span>/</span>
                <Link 
                    href={`/?category=${encodeURIComponent(product.category)}`} 
                    className="capitalize font-medium transition-colors hover:text-primary"
                >
                    {product.category}
                </Link>
                <span>/</span>
                <span className="font-bold text-text">{product.name}</span>
            </nav>
            
            <div className="my-6">
                <Link
                    href="/"
                    className="group inline-flex items-center gap-2 rounded-full border border-primary/30 bg-surface px-4 py-2 text-sm font-bold text-primary shadow-sm transition-all duration-300 hover:scale-105 hover:border-primary hover:shadow-md active:scale-95"
                >
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        className="transition-transform duration-300 group-hover:-translate-x-1"
                    >
                        <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Quay lại
                </Link>
            </div>

            <div className="grid grid-cols-1 items-start gap-10 md:grid-cols-2">
                {/* Ảnh sản phẩm chính */}
                <div className="flex justify-center rounded-3xl border border-primary/15 bg-surface p-8 shadow-sm">
                    <div className="relative flex h-80 w-80 items-center justify-center overflow-hidden rounded-full bg-background shadow-inner">
                        {product.imageUrl ? (
                            <Image
                                src={product.imageUrl}
                                alt={product.name}
                                fill
                                priority
                                sizes="320px"
                                className="object-cover"
                            />
                        ) : (
                            <span className="text-7xl">☕</span>
                        )}
                    </div>
                </div>

                <div className="flex flex-col gap-5">
                    <div>
                        <h1 className="text-3xl font-extrabold text-text">{product.name}</h1>
                        {product.description && (
                            <p className="mt-1.5 text-sm leading-relaxed text-text/70">{product.description}</p>
                        )}

                        {hasToppings ? (
                            <div className="mt-4 flex items-center justify-between gap-4 rounded-2xl bg-background/50 p-3">
                                <div>
                                    <span className="text-3xl font-black text-primary">
                                        {basePrice.toLocaleString('vi-VN')}đ
                                    </span>
                                    <p className="text-xs font-medium text-text/50">(Giá Size {selectedSize})</p>
                                </div>

                                {product.prices && product.prices.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-text">Kích thước:</span>
                                        <div className="flex gap-2">
                                            {product.prices.map((p) => (
                                                <button
                                                    key={p.id}
                                                    type="button"
                                                    onClick={() => { setSelectedSize(p.size); setQuantity(1); }}
                                                    className={`h-9 w-11 rounded-xl text-xs font-bold transition-all duration-200 ${
                                                        selectedSize === p.size
                                                            ? 'scale-105 bg-primary text-white shadow-md'
                                                            : 'border border-primary/20 bg-surface text-text hover:border-primary'
                                                    }`}
                                                >
                                                    {p.size}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="mt-4 flex items-baseline gap-2">
                                <span className="text-3xl font-black text-primary">
                                    {basePrice.toLocaleString('vi-VN')}đ
                                </span>
                                <span className="text-sm font-medium text-text/50">(Giá Size {selectedSize})</span>
                            </div>
                        )}
                    </div>

                    <hr className="border-primary/15" />

                    {hasToppings ? (
                        <div className="rounded-2xl border border-primary/20 bg-surface p-5 shadow-sm">
                            <div className="mb-4 flex items-center justify-between">
                                <label className="text-sm font-bold text-text">Chọn Topping thêm:</label>
                                {totalToppingPrice > 0 && (
                                    <span className="rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">
                                        + {totalToppingPrice.toLocaleString('vi-VN')}đ
                                    </span>
                                )}
                            </div>

                            <div className="flex max-h-60 flex-col gap-3 overflow-y-auto pr-1">
                                {toppingsList.map((top) => {
                                    const qty = toppingQuantities[top.id] || 0;
                                    return (
                                        <div
                                            key={top.id}
                                            className="flex items-center justify-between rounded-xl border border-primary/10 bg-background p-3"
                                        >
                                            <div className="flex flex-col">
                                                <span className="text-sm font-semibold text-text">{top.name}</span>
                                                <span className="text-xs font-bold text-primary">
                                                    +{Number(top.price).toLocaleString('vi-VN')}đ
                                                </span>
                                            </div>

                                            <div className="flex items-center gap-1.5 rounded-xl border border-primary/20 bg-surface p-1 shadow-sm">
                                                <button
                                                    type="button"
                                                    onClick={() => handleToppingQtyChange(top.id, -1)}
                                                    className="h-7 w-7 rounded-lg text-sm font-bold text-text transition-colors hover:bg-primary/10"
                                                >
                                                    -
                                                </button>
                                                
                                                <input
                                                    type="text"
                                                    inputMode="numeric"
                                                    pattern="[0-9]*"
                                                    value={qty === 0 ? '' : qty}
                                                    placeholder="0"
                                                    onFocus={(e) => e.target.select()}
                                                    onMouseUp={(e) => e.preventDefault()}
                                                    onChange={(e) => {
                                                        const cleaned = e.target.value.replace(/\D/g, '').replace(/^0+/, '');
                                                        const val = cleaned === '' ? 0 : parseInt(cleaned, 10);
                                                        setToppingQuantities((prev) => ({
                                                            ...prev,
                                                            [top.id]: isNaN(val) ? 0 : val,
                                                        }));
                                                    }}
                                                    className="w-9 bg-transparent text-center text-sm font-bold outline-none"
                                                />

                                                <button
                                                    type="button"
                                                    onClick={() => handleToppingQtyChange(top.id, 1)}
                                                    className="h-7 w-7 rounded-lg text-sm font-bold text-text transition-colors hover:bg-primary/10"
                                                >
                                                    +
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        product.prices && product.prices.length > 0 && (
                            <div>
                                <label className="mb-3 block text-sm font-bold text-text">Kích thước:</label>
                                <div className="flex gap-4">
                                    {product.prices.map((p) => (
                                        <button
                                            key={p.id}
                                            type="button"
                                            onClick={() => { setSelectedSize(p.size); setQuantity(1); }}
                                            className={`h-11 w-14 rounded-2xl text-sm font-bold transition-all duration-200 ${
                                                selectedSize === p.size
                                                    ? 'scale-105 bg-primary text-white shadow-md'
                                                    : 'border border-primary/20 bg-surface text-text hover:border-primary'
                                            }`}
                                        >
                                            {p.size}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )
                    )}


                    <div className="flex items-center justify-between py-1">
                        <span className="text-sm font-bold text-text">Số lượng ly:</span>
                        <div className={`flex items-center gap-3 rounded-2xl border border-primary/20 bg-surface p-1.5 shadow-sm ${
                            isOutOfStock ? 'opacity-40 pointer-events-none' : ''
                        }`}>
                            <button
                                type="button"
                                disabled={isOutOfStock || quantity <= 1}
                                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                                className="h-8 w-8 rounded-xl text-sm font-bold text-text transition-colors hover:bg-primary/10 active:scale-95 disabled:opacity-30"
                            >
                                -
                            </button>
                            <input
                                type="text"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                disabled={isOutOfStock}
                                value={isOutOfStock ? 0 : quantity === 0 ? '' : quantity}
                                placeholder="1"
                                onFocus={(e) => e.target.select()}
                                onMouseUp={(e) => e.preventDefault()}
                                onChange={(e) => {
                                    const cleaned = e.target.value.replace(/\D/g, '').replace(/^0+/, '');
                                    if (cleaned === '') {
                                        setQuantity(0);
                                    } else {
                                        const val = Math.min(availableStock, parseInt(cleaned, 10));
                                        setQuantity(isNaN(val) ? 1 : val);
                                    }
                                }}
                                onBlur={() => {
                                    if (!quantity || quantity < 1) setQuantity(1);
                                }}
                                className="w-8 bg-transparent text-center text-base font-bold outline-none"
                            />
                            <button
                                type="button"
                                disabled={isOutOfStock || quantity >= availableStock}
                                onClick={() => setQuantity((q) => Math.min(availableStock, q + 1))}
                                className="h-8 w-8 rounded-xl text-sm font-bold text-text transition-colors hover:bg-primary/10 active:scale-95 disabled:opacity-30"
                            >
                                +
                            </button>
                        </div>
                    </div>

                    <div className="flex items-center justify-between gap-4 rounded-2xl border border-primary/20 bg-primary/10 p-5">
                        <div>
                            <p className="text-xs font-semibold text-text/70">Tổng tiền tạm tính:</p>
                            <p className="text-2xl font-black text-primary">
                                {grandTotal.toLocaleString('vi-VN')}đ
                            </p>
                        </div>

                        {isOutOfStock ? (
                            <button
                                type="button"
                                disabled
                                className="cursor-not-allowed rounded-full bg-gray-300 px-7 py-3 text-sm font-bold text-gray-500 shadow-none"
                            >
                                Tạm hết hàng
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={handleAddToCart}
                                disabled={adding}
                                className="rounded-full bg-primary px-7 py-3 text-sm font-bold text-white shadow-md transition-all hover:bg-primary-hover active:scale-95 disabled:opacity-50"
                            >
                                Thêm vào giỏ
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Hộp thoại thông báo. */}
            {showSuccessModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-md overflow-hidden rounded-2xl bg-surface shadow-2xl border border-primary/20 transition-all">
                        <div className="flex items-center justify-between bg-primary/10 px-5 py-3.5 border-b border-primary/15">
                            <div className="flex items-center gap-2 text-primary font-bold text-sm">
                                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white text-xs">✓</span>
                                Thêm vào giỏ hàng thành công
                            </div>
                            <button
                                onClick={() => setShowSuccessModal(false)}
                                className="text-text/50 hover:text-text text-xl font-bold leading-none transition-colors"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-5">
                            <div className="flex items-center gap-4 pb-4 border-b border-primary/10">
                                <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-xl bg-background border border-primary/15 flex items-center justify-center">
                                    {product.imageUrl ? (
                                        <Image
                                            src={product.imageUrl}
                                            alt={product.name}
                                            fill
                                            sizes="64px"
                                            className="object-cover"
                                        />
                                    ) : (
                                        <span className="text-2xl">☕</span>
                                    )}
                                </div>
                                <div className="flex-1">
                                    <h4 className="font-bold text-text text-base">{product.name}</h4>
                                    <p className="text-xs text-text/60 mt-0.5 font-medium">Size {selectedSize}</p>
                                </div>
                            </div>

                            <div className="flex items-center justify-between py-4 border-b border-primary/10">
                                <span className="text-sm font-semibold text-text/80">Giỏ hàng hiện có</span>
                                <div className="text-right">
                                    <p className="text-base font-extrabold text-primary">
                                        {grandTotal.toLocaleString('vi-VN')}đ
                                    </p>
                                    <p className="text-xs text-text/50 font-medium">({quantity}) sản phẩm</p>
                                </div>
                            </div>

                            <div className="mt-5 grid grid-cols-2 gap-3">
                                <button
                                    type="button"
                                    onClick={() => setShowSuccessModal(false)}
                                    className="w-full rounded-full border border-primary/30 py-2.5 text-sm font-bold text-primary bg-surface hover:bg-primary/10 transition-colors"
                                >
                                    Tiếp tục mua hàng
                                </button>
                                <button
                                    type="button"
                                    onClick={() => router.push('/cart')}
                                    className="w-full rounded-full bg-primary py-2.5 text-sm font-bold text-white hover:bg-primary-hover transition-colors shadow-sm"
                                >
                                    Xem giỏ hàng
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}
