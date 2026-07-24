# ملخص التعديلات — Qarari AI

## 1. تعديل GuideScreen (دليل الاستخدام)
- **ملف:** `src/components/GuideScreen.tsx`
- تم تغيير "50 تحليل شهري (بدل 10 في المجاني)" إلى **"50 تحليل شهري (بدل 5 في المجاني)"**
- تم **حذف** جملة "300 رسالة شات شهرية للمساعد (بدل 300 للمجاني)" بالكامل

## 2. تعديل سعر الاشتراك إلى 150 EGP
| الملف | التعديل |
|--------|---------|
| `src/components/UpgradeScreen.tsx` | 149 EGP → **150 EGP** |
| `src/lib/types.ts` | `MONTHLY_PRICE = 149` → **150** |
| `api/subscribe.ts` | `MONTHLY_PRICE = 149` → **150** |
| `api/admin/metrics.ts` | `MONTHLY_PRICE = 149` → **150** |

## 3. ربط الذاكرة الذكية بتسجيل الدخول
- **ملف:** `src/components/AdvisorScreen.tsx` (جديد)
- عند فتح المساعد الشخصي بدون تسجيل دخول، يظهر:
  - **رسالة:** "عشان أقدر أفتكر اهتماماتك وأقدملك نصائح مخصصة ليك، ياريت تسجل دخولك"
  - زر "سجّل دخولك" يوجه لصفحة تسجيل الدخول فوراً
- **ملف:** `api/ask.ts` — الـ API يرجع 401 `auth_required_for_advisor` إذا لم يسجل المستخدم
- **ملف:** `src/components/InputScreen.tsx` — زر المساعد على الصفحة الرئيسية يتحقق من تسجيل الدخول

## 4. Proactive Suggestions (نصائح استباقية)
- **ملف:** `src/components/AdvisorScreen.tsx`
- بعد كل رد من المساعد، تظهر نصيحة استباقية ذكية بناءً على السياق
- أمثلة:
  - "الموديل اللي بتسأل عليه ده نزل منه نسخة أحدث، تحب أقارنلك؟"
  - "في عرض جديد على iPhone 14 دلوقت!"
  - "لافتوبات للدراسة، الـ Acer و Lenovo معمولين عليهم عروض كويسة!"
- **ملف:** `api/ask.ts` — تحديث prompt المساعد ليطلب نصائح استباقية

## 5. Smart Memory System (ذاكرة ذكية)
- **ملف:** `api/ask.ts` — بعد كل سؤال في وضع advisor:
  - يستخرج كلمات مفتاحية (موبايل، لابتوب، سماعات، إلخ)
  - يحفظ الاهتمامات في جدول `user_interests`
  - يحفظ آخر 20 بحث في `recent_searches`
  - دمج تلقائي مع الاهتمامات السابقة
- **ملف:** `supabase-user-interests-migration.sql` (جديد) — إنشاء جدول `user_interests` و `advisor_usage`
- **ملف:** `src/components/AdvisorScreen.tsx` — عرض مؤشر "الذاكرة الذكية نشطة"

## 6. Shopping Advisor Mode (وضع المساعد الشخصي)
- **ملف:** `src/components/AdvisorScreen.tsx` (جديد) — شاشة كاملة للمساعد الشخصي
- **ملف:** `src/components/InputScreen.tsx` — إضافة قسم "المساعد الشخصي الذكي" على الصفحة الرئيسية
- **ملف:** `src/components/Header.tsx` — إضافة أيقونة المساعد في الـ header
- **ملف:** `src/App.tsx` — إضافة route للشاشة الجديدة
- **ملف:** `src/lib/types.ts` — إضافة "advisor" للـ Screen type
- العميل يقدر يسأل: "معايا 30 ألف وعايز لابتوب للدراسة" أو "إيه أحسن موبايل كاميرا في 25 ألف؟"
- المساعد يرد بنصائح شخصية وأسعار حقيقية

## تحديث خطط الاشتراك ومقارنة أسعار المتاجر (هذا التحديث)

### 1. تحديث أرقام خطط الاشتراك — `api/_planConfig.ts`
| الخطة | السعر | تحاليل | مقارنات | رسائل شات |
|-------|-------|--------|---------|-----------|
| small_bundle | 49 | 4 | 0 | 45 |
| medium_bundle | 79 | 7 | 0 | 90 |
| large_bundle | 119 | 11 | 0 | 150 |
| smart_shopper | 150 | 16 | 3 | 150 |
| power_buyer | 300 | 30 | 8 | 400 |

تم تحديث حقل `description` لكل باقة ليعكس الأرقام الجديدة.

### 2. مقارنة أسعار المتاجر داخل ReportScreen
- **`api/_groq_tavily.ts`**: دالة جديدة `extractRetailerPrices()` تستخرج أرخص سعر ورابط مباشر من نتايج "Search 2: Largest Marketplace" الموجودة أصلاً (بدون أي Serper إضافي) لكل من Jumia وNoon (وB.TECH لو `SHOW_BTECH_COMPARISON=true`)، مع استبعاد amazon.eg تمامًا. `smartAdaptiveSearch` بترجع دلوقتي `retailerSearchResults` كجزء من الـ return، و`callAiWithFallback` بيمررها للخارج.
- **`api/analyze.ts`**: بينادي `extractRetailerPrices` بعد نتيجة الـ AI ويخزنها في `parsed.retailerPrices` (فبتترخزن مع الكاش كمان).
- **`src/lib/types.ts`**: حقل جديد `retailerPrices?` في `AnalysisResult`، وثابت `SHOW_BTECH_COMPARISON` (حاليًا `false`).
- **`src/components/ReportScreen.tsx`**: كومبوننت جديد `RetailerPriceComparison` يظهر تحت "Market Overview" لو فيه أكتر من متجر، بنفس ثيم الموقع (خلفية داكنة، amber/gold، RTL)، مع badge أخضر لأرخص سعر، وتنبيه واضح إن الأسعار "آخر سعر اتفحص" وممكن تتغير.
- **`SETUP.md`**: توثيق env var اختياري جديد `SHOW_BTECH_COMPARISON`.
