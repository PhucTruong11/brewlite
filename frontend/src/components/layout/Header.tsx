'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { OrderNotifications } from '@/components/orders/OrderNotifications';
import { useAuth } from '@/hooks/useAuth';
import { useCategories } from '@/hooks/useCategories';
import { useCartStore, useHasCartHydrated } from '@/stores/cart.store';
import { formatCartToppings, getCartItemKey, getCartLineTotal } from '@/lib/cart';

const MenuIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
  </svg>
);

const SearchIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" strokeLinecap="round" />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={`transition-transform ${open ? 'rotate-180' : ''}`}
  >
    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function Header() {
  const [isSidebarOpen, setSidebarOpen] = useState(false);
  const [isMenuOpen, setMenuOpen] = useState(false);
  const [isCartHovered, setIsCartHovered] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  const hasHydrated = useHasCartHydrated();
  const { user, loading, error: authError, refetchUser, logout } = useAuth();
  const { categories } = useCategories();
  const router = useRouter();

  const cartItems = useCartStore((s) => s.items);
  const cartCount = useCartStore((s) => s.totalItems());
  const cartTotalPrice = useCartStore((s) => s.totalPrice());
  const removeItem = useCartStore((s) => s.removeItem);

  const menuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleUnauthorized() {
      router.push('/auth/login');
    }
    window.addEventListener('unauthorized', handleUnauthorized);
    return () => window.removeEventListener('unauthorized', handleUnauthorized);
  }, [router]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
      // Bổ sung đóng User Menu khi click ra ngoài
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setIsUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    router.push(`/?q=${encodeURIComponent(q)}`);
  };

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 bg-surface px-4 py-3 shadow-sm lg:px-8">
        <Link href="/" className="shrink-0 text-2xl font-extrabold text-primary">
          BrewLite
        </Link>

        <div className="hidden flex-1 items-center justify-center gap-6 lg:flex">
          <nav className="flex items-center gap-6 text-base font-semibold text-text">
            <Link href="/" className="whitespace-nowrap hover:text-primary">
              Trang chủ
            </Link>

            {/* Menu Dropdown sử dụng dữ liệu từ Hook useCategories */}
            <div
              ref={menuRef}
              className="relative"
              onMouseEnter={() => setMenuOpen(true)}
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button
                className="flex items-center gap-1 whitespace-nowrap hover:text-primary"
                aria-expanded={isMenuOpen}
              >
                Menu
                <ChevronIcon open={isMenuOpen} />
              </button>

              {isMenuOpen && (
                <div className="absolute left-1/2 top-full z-40 w-56 -translate-x-1/2 rounded-xl border border-primary/10 bg-surface p-2 shadow-lg">
                  <Link
                    href="/?view=all"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-lg px-3 py-2 text-sm font-bold text-primary hover:bg-background"
                  >
                    Tất cả
                  </Link>
                  {categories.map((cat) => (
                    <Link
                      key={cat.slug}
                      href={`/?category=${encodeURIComponent(cat.slug)}`}
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-lg px-3 py-2 text-sm font-medium text-text hover:bg-background hover:text-primary"
                    >
                      {cat.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <Link href="/orders" className="whitespace-nowrap hover:text-primary">
              Lịch sử
            </Link>
          </nav>

          <form onSubmit={handleSearchSubmit} className="relative w-full max-w-xs">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text/50">
              <SearchIcon />
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm món, ví dụ: cà phê sữa..."
              className="w-full rounded-full border border-primary/15 bg-background py-1.5 pl-9 pr-3 text-sm text-text outline-none focus:border-primary"
            />
          </form>
        </div>

        <div className="hidden shrink-0 items-center gap-5 lg:flex">
          {/* POPUP GIỎ HÀNG KHI HOVER */}
          <div
            className="relative py-2"
            onMouseEnter={() => setIsCartHovered(true)}
            onMouseLeave={() => setIsCartHovered(false)}
          >
            <Link
              href="/cart"
              className="flex items-center gap-1.5 text-base font-semibold text-text hover:text-primary"
            >
              <span>Giỏ hàng ({hasHydrated ? cartCount : 0})</span>
            </Link>

            {isCartHovered && (
              <div className="absolute right-0 top-full z-50 w-80 rounded-2xl border border-primary/15 bg-surface p-4 shadow-xl transition-all">
                <h4 className="border-b border-primary/10 pb-2.5 text-sm font-bold text-text">
                  Sản phẩm đã chọn
                </h4>

                {cartItems.length === 0 ? (
                  <div className="py-8 text-center text-xs font-medium text-text/60">
                    Giỏ hàng của bạn đang trống
                  </div>
                ) : (
                  <>
                    <div className="my-2 flex max-h-72 flex-col divide-y divide-primary/10 overflow-y-auto pr-1">
                      {cartItems.map((item, idx) => (
                        <div key={getCartItemKey(item)} className="group/item relative flex items-center gap-3 py-2.5 pr-5">
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-primary/10 bg-background">
                            {item.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={item.imageUrl}
                                alt={item.name}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <span className="text-xl">☕</span>
                            )}
                          </div>

                          <div className="flex-1 overflow-hidden">
                            <h5 className="truncate text-xs font-bold text-text">
                              {item.name}
                            </h5>
                            <p className="text-[11px] font-semibold text-text/60">
                              Size {item.size} × {item.quantity}
                            </p>

                            {item.toppings && item.toppings.length > 0 && (
                              <p className="truncate text-[10px] text-text/50">
                                + {formatCartToppings(item.toppings)}
                              </p>
                            )}
                          </div>

                          <div className="text-right">
                            <span className="text-xs font-black text-primary">
                              {getCartLineTotal(item).toLocaleString('vi-VN')}đ
                            </span>
                          </div>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              removeItem(idx);
                            }}
                            aria-label="Xóa sản phẩm"
                            className="absolute right-0 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-text/40 transition-colors hover:bg-red-50 hover:text-red-500"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className="border-t border-primary/10 pt-3">
                      <div className="mb-3 flex items-center justify-between text-xs font-bold text-text">
                        <span>Tổng tiền:</span>
                        <span className="text-sm font-black text-primary">
                          {cartTotalPrice.toLocaleString('vi-VN')}đ
                        </span>
                      </div>

                      <button
                        onClick={() => router.push('/cart')}
                        className="w-full rounded-full bg-primary py-2 text-center text-xs font-bold text-white shadow-sm transition-colors hover:bg-primary-hover"
                      >
                        Thanh toán
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {user && <OrderNotifications key={user.id} userId={user.id} />}
          {/* KHU VỰC TÀI KHOẢN KHÁCH HÀNG */}
          {loading ? (
            <div className="h-8 w-24 animate-pulse rounded-full bg-primary/10" />
          ) : authError && !user ? (
            <button type="button" onClick={() => void refetchUser()} className="text-sm font-semibold text-primary">
              Kiểm tra lại phiên đăng nhập
            </button>
          ) : user ? (
            <div ref={userMenuRef} className="relative py-2">
              <button
                type="button"
                onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                className="flex items-center gap-2 rounded-full border border-primary/20 px-3 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-background hover:text-primary active:scale-95"
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
                <span className="max-w-[120px] truncate" title={user.email}>
                  {user.name || user.email}
                </span>
                <ChevronIcon open={isUserMenuOpen} />
              </button>

              {isUserMenuOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-2xl border border-primary/15 bg-surface p-2 shadow-xl transition-all">
                  <div className="mb-1 rounded-t-xl border-b border-primary/10 bg-primary/5 px-3 py-2">
                    <p className="truncate text-sm font-bold text-text">{user.name || 'Thành viên'}</p>
                    <p className="truncate text-xs text-text/60">{user.email}</p>
                  </div>

                  <div className="py-1">
                    <Link
                      href="/profile"
                      onClick={() => setIsUserMenuOpen(false)}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-text transition-colors hover:bg-background hover:text-primary"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                        <circle cx="12" cy="7" r="4" />
                      </svg>
                      Thông tin tài khoản
                    </Link>

                    <Link
                      href="/rewards"
                      onClick={() => setIsUserMenuOpen(false)}
                      className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-text transition-colors hover:bg-background hover:text-primary"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      Điểm thưởng
                    </Link>
                  </div>

                  <div className="mt-1 border-t border-primary/10 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setIsUserMenuOpen(false);
                        setShowLogoutModal(true);
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-red-500 transition-colors hover:bg-red-50 hover:text-red-600"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                        <polyline points="16 17 21 12 16 7" />
                        <line x1="21" y1="12" x2="9" y2="12" />
                      </svg>
                      Đăng xuất
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link
                href="/auth/login"
                className="rounded-full border border-primary/20 px-4 py-1.5 text-sm font-semibold text-text transition-colors hover:bg-background hover:text-primary"
              >
                Đăng nhập
              </Link>
              <Link
                href="/auth/register"
                className="rounded-full bg-primary px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover"
              >
                Đăng ký
              </Link>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 lg:hidden">
          {user && <OrderNotifications key={user.id} userId={user.id} />}
          <button onClick={() => setSidebarOpen(true)} aria-label="Mở menu" className="text-text">
            <MenuIcon />
          </button>
        </div>
      </header>

      {/* MODAL THÔNG BÁO XÁC NHẬN ĐĂNG XUẤT */}
      {showLogoutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-3xl border border-primary/10 bg-surface p-6 text-center shadow-2xl">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-red-100 text-red-500">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-bold text-text">Xác nhận đăng xuất</h3>
            <p className="mb-6 text-sm text-text/60">
              Bạn có chắc chắn muốn đăng xuất khỏi <span className="font-semibold text-text">{user?.email}</span>?
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowLogoutModal(false)}
                className="flex-1 rounded-xl border border-primary/20 py-2.5 text-sm font-bold text-text transition-colors hover:bg-background"
              >
                Hủy
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLogoutModal(false);
                  logout();
                }}
                className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-bold text-white shadow-md transition-colors hover:bg-red-600"
              >
                Đăng xuất
              </button>
            </div>
          </div>
        </div>
      )}

      <Sidebar isOpen={isSidebarOpen} onClose={() => setSidebarOpen(false)} />
    </>
  );
}
