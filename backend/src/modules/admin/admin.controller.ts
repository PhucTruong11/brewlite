import {
    BadRequestException, Body, Controller, Get, Param, ParseEnumPipe, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ProductSize } from '@prisma/client';
import { AdminService } from './admin.service.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto.js';
import { UpdateStockDto } from './dto/update-stock.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CreatePromotionDto } from './dto/create-promotion.dto.js';
import { UpdatePromotionDto } from './dto/update-promotion.dto.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CreateIngredientDto, UpdateIngredientDto, RestockIngredientDto, } from './dto/ingredient.dto.js';
import { SaveRecipeDto } from './dto/save-recipe.dto.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
    constructor(private readonly adminService: AdminService) { }

    // ĐƠN HÀNG & THỐNG KÊ (ORDERS & STATS)
    // GET /api/admin/orders/counts
    @Get('orders/counts')
    async getCounts() {
        return { data: await this.adminService.getCounts() };
    }

    // GET /api/admin/orders?status=PAID,PREPARING&range=today&search=abc&page=1
    @Get('orders')
    async listOrders(@Query() query: ListOrdersQueryDto) {
        return { data: await this.adminService.listOrders(query) };
    }

    // PATCH /api/admin/orders/:id/status
    @Patch('orders/:id/status')
    async updateStatus(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdateOrderStatusDto,
    ) {
        return { data: await this.adminService.updateStatus(id, dto.status) };
    }

    // QUẢN LÝ KHO (INVENTORY / STOCK)
    // GET /api/admin/products?category=tra&search=olong
    @Get('products')
    async listProducts(
        @Query('category') category?: string,
        @Query('search') search?: string,
    ) {
        return { data: await this.adminService.listProducts(category, search) };
    }

    // Chỉ đọc dữ liệu nguyên liệu và công thức để hiển thị trên hai trang admin mới.
    @Get('ingredients')
    async listIngredients() {
        return { data: await this.adminService.listIngredients() };
    }

    @Get('recipes')
    async listRecipes(
        @Query('productId') productId?: string,
        @Query('size') size?: string,
        @Query('toppingId') toppingId?: string,
    ) {
        if (toppingId && !productId && !size) {
            return { data: await this.adminService.listToppingRecipe(toppingId) };
        }
        if (productId && !toppingId && size && Object.values(ProductSize).includes(size as ProductSize)) {
            return { data: await this.adminService.listProductRecipe(productId, size as ProductSize) };
        }
        throw new BadRequestException('Chọn productId cùng size S/M/L hoặc chỉ chọn toppingId');
    }

    // POST /api/admin/ingredients
    @Post('ingredients')
    async createIngredient(@Body() dto: CreateIngredientDto) {
        return { data: await this.adminService.createIngredient(dto) };
    }

    // PATCH /api/admin/ingredients/:id
    @Patch('ingredients/:id')
    async updateIngredient(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdateIngredientDto,
    ) {
        return { data: await this.adminService.updateIngredient(id, dto) };
    }

    // POST /api/admin/ingredients/:id/restock
    @Post('ingredients/:id/restock')
    async restockIngredient(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: RestockIngredientDto,
    ) {
        return { data: await this.adminService.restockIngredient(id, dto) };
    }

    // PUT /api/admin/recipes/products/:id/:size
    @Put('recipes/products/:id/:size')
    async saveProductRecipe(
        @Param('id', ParseUUIDPipe) id: string,
        @Param('size', new ParseEnumPipe(ProductSize)) size: ProductSize,
        @Body() dto: SaveRecipeDto,
    ) {
        return {
            data: await this.adminService.saveProductRecipe(id, size, dto),
        };
    }

    // PUT /api/admin/recipes/toppings/:id
    @Put('recipes/toppings/:id')
    async saveToppingRecipe(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: SaveRecipeDto,
    ) {
        return { data: await this.adminService.saveToppingRecipe(id, dto) };
    }

    // PATCH /api/admin/products/:id/stock
    @Patch('products/:id/stock')
    async updateStock(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdateStockDto,
    ) {
        return { data: await this.adminService.updateStock(id, dto) };
    }

    // PATCH /api/admin/products/:id/availability
    @Patch('products/:id/availability')
    async toggleAvailability(@Param('id', ParseUUIDPipe) id: string) {
        return { data: await this.adminService.toggleProductAvailability(id) };
    }

    // GET /api/admin/promotions - danh sách voucher
    @Get('promotions')
    async listPromotions() {
        return { data: await this.adminService.listPromotions() };
    }

    // PATCH /api/admin/promotions/:id/active - bật / tắt voucher
    @Patch('promotions/:id/active')
    async togglePromotion(@Param('id', ParseUUIDPipe) id: string) {
        return { data: await this.adminService.togglePromotionActive(id) };
    }

    // PATCH /api/admin/promotions/:id
    @Patch('promotions/:id')
    async updatePromotion(
        @Param('id', ParseUUIDPipe) id: string,
        @Body() dto: UpdatePromotionDto,
    ) {
        return { data: await this.adminService.updatePromotion(id, dto) };
    }

    // POST /api/admin/promotions
    @Post('promotions')
    async createPromotion(
        @Body() dto: CreatePromotionDto) {
        const result = await this.adminService.createPromotion(dto);
        return { message: 'Tạo mã voucher thành công!', data: result, };
    }
}
