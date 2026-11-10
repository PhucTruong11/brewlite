'use client';

import { useSearchParams } from 'next/navigation';
import { PromoCarousel } from './PromoCarousel';
import { BestSellers } from './BestSellers';
import { AllDrinksScroll } from './AllDrinksScroll';

export function HomeSections() {
    const searchParams = useSearchParams();
    const hasSpecificFilter = !!searchParams.get('category') || !!searchParams.get('q');

    return (
        <>
            <PromoCarousel />
            {!hasSpecificFilter && <BestSellers />}
            <AllDrinksScroll />
        </>
    );
}
