from pathlib import Path
import os
import re
import textwrap

import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

try:
    from anthropic import Anthropic
except ImportError:  # Optional dependency for LLM summaries
    Anthropic = None

PLATFORM_COLORS: dict[str, str] = {
    'Rappi': '#E65100',
    'Uber Eats': '#1565C0',
}
PAGE_SIZE = (8.5, 11)


def main() -> None:
    root = Path('.')
    output_dir = root / 'output'
    rappi_path = output_dir / 'rappi-results.json'
    ubereats_path = output_dir / 'ubereats-results.json'
    report_path = output_dir / 'competitive-insights.pdf'

    frames = []
    for path in (rappi_path, ubereats_path):
        if path.exists():
            try:
                data = pd.read_json(path)
            except ValueError:
                continue

            if not data.empty:
                frames.append(data)

    if not frames:
        raise SystemExit('No hay datos para generar el reporte.')

    df = pd.concat(frames, ignore_index=True)

    for col in ['precio_producto', 'precio_envio', 'precio_producto_original', 'rating']:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce')

    if 'tiempo_entrega' in df.columns:
        df['tiempo_entrega_min'] = df['tiempo_entrega'].apply(parse_delivery_minutes)
    else:
        df['tiempo_entrega_min'] = None

    available_df = df[df['disponible'] == True].copy()
    available_df['tiene_descuento'] = available_df.apply(has_discount, axis=1)
    available_df['precio_envio_es_promo'] = available_df.apply(is_promo_fee, axis=1)

    descriptions = build_llm_descriptions(df, available_df)

    with PdfPages(report_path) as pdf:
        fig = plt.figure(figsize=PAGE_SIZE)
        fig.text(0.07, 0.94, 'Competitive Intelligence - Resumen de Scrapeos', fontsize=16, weight='bold')
        fig.text(0.07, 0.89, f'Registros totales: {len(df)}', fontsize=11)
        fig.text(0.07, 0.85, f'Registros disponibles: {len(available_df)}', fontsize=11)
        fig.text(0.07, 0.80, descriptions['intro'], fontsize=10, wrap=True)
        fig.text(0.07, 0.72, 'Notas:', fontsize=12, weight='bold')
        notes = [
            '- Los resultados reflejan el horario de ejecucion (posibles locales cerrados).',
            '- Cuando un local no aparece o no dispara endpoint, se registra como no disponible.',
            '- Envio $0 en Uber Eats puede ser promo de usuario nuevo o suscripcion Uber One.',
        ]
        for i, note in enumerate(notes):
            fig.text(0.07, 0.67 - i * 0.05, note, fontsize=10)
        plt.axis('off')
        pdf.savefig(fig)
        plt.close(fig)

        llm_summary = sanitize_matplotlib_text(build_llm_summary(df, available_df))
        if llm_summary:
            fig = plt.figure(figsize=PAGE_SIZE)
            fig.text(0.07, 0.94, 'Resumen Competitivo', fontsize=16, weight='bold')
            fig.text(0.07, 0.88, llm_summary, fontsize=9, va='top')
            plt.axis('off')
            pdf.savefig(fig)
            plt.close(fig)

        positioning_raw = build_positioning_summary_llm(df, available_df)
        if positioning_raw:
            fig = plt.figure(figsize=PAGE_SIZE)
            fig.text(0.07, 0.94, 'Posicionamiento Competitivo de Rappi', fontsize=16, weight='bold')
            wrapped = sanitize_matplotlib_text(textwrap.fill(positioning_raw, width=88))
            fig.text(0.07, 0.87, wrapped, fontsize=9, va='top')
            plt.axis('off')
            pdf.savefig(fig)
            plt.close(fig)

        if not available_df.empty:
            price_pivot = (
                available_df
                .groupby(['producto', 'plataforma'])['precio_producto']
                .mean()
                .unstack()
            )
            fig, ax = plt.subplots(figsize=PAGE_SIZE)
            fig.text(0.07, 0.94, 'Precio promedio por producto y plataforma', fontsize=14, weight='bold')
            fig.text(0.07, 0.91, descriptions['price'], fontsize=9)
            bar_colors = [PLATFORM_COLORS.get(c, '#888888') for c in price_pivot.columns]
            price_pivot.plot(kind='bar', ax=ax, color=bar_colors, width=0.6)
            ax.set_ylabel('Precio promedio (MXN)')
            ax.set_xlabel('')
            ax.tick_params(axis='x', rotation=20)
            ax.legend(title='Plataforma')
            for container in ax.containers:
                ax.bar_label(container, fmt='$%.0f', padding=3, fontsize=8)
            fig.tight_layout(rect=[0, 0, 1, 0.86])
            pdf.savefig(fig)
            plt.close(fig)

        if not available_df.empty:
            discount_pivot = (
                available_df
                .groupby(['producto', 'plataforma'])['tiene_descuento']
                .mean()
                .unstack()
                .mul(100)
            )
            if not discount_pivot.empty:
                fig, ax = plt.subplots(figsize=PAGE_SIZE)
                fig.text(0.07, 0.94, 'Tasa de descuento por producto y plataforma', fontsize=14, weight='bold')
                fig.text(0.07, 0.91, '% de registros disponibles que presentaron algun descuento activo, por producto.', fontsize=9)
                bar_colors = [PLATFORM_COLORS.get(c, '#888888') for c in discount_pivot.columns]
                discount_pivot.plot(kind='bar', ax=ax, color=bar_colors, width=0.6)
                ax.set_ylabel('% con descuento')
                ax.set_xlabel('')
                ax.set_ylim(0, 110)
                ax.tick_params(axis='x', rotation=20)
                ax.legend(title='Plataforma')
                for container in ax.containers:
                    ax.bar_label(container, fmt='%.0f%%', padding=3, fontsize=8)
                fig.tight_layout(rect=[0, 0, 1, 0.86])
                pdf.savefig(fig)
                plt.close(fig)

        if not available_df.empty:
            fee = available_df.groupby('plataforma')['precio_envio'].mean().fillna(0)
            if not fee.empty:
                promo_note = ''
                if 'precio_envio_es_promo' in available_df.columns:
                    promo_counts = available_df[available_df['precio_envio_es_promo']].groupby('plataforma').size()
                    parts = [f"{p}: {n} reg. con fee promocional (usuario nuevo/Uber One)" for p, n in promo_counts.items()]
                    if parts:
                        promo_note = 'Nota: ' + ' | '.join(parts)
                fig, ax = plt.subplots(figsize=PAGE_SIZE)
                fig.text(0.07, 0.94, 'Costo de envio promedio por plataforma', fontsize=14, weight='bold')
                fig.text(0.07, 0.91, descriptions['fee'], fontsize=9)
                if promo_note:
                    fig.text(0.07, 0.88, promo_note, fontsize=8, color='darkorange')
                bar_colors = [PLATFORM_COLORS.get(p, '#888888') for p in fee.index]
                fee.plot(kind='bar', ax=ax, color=bar_colors, width=0.5, legend=False)
                ax.set_ylabel('Costo de envio promedio (MXN)')
                ax.set_xlabel('')
                ax.tick_params(axis='x', rotation=0)
                for container in ax.containers:
                    ax.bar_label(container, fmt='$%.1f', padding=3, fontsize=9)
                fig.tight_layout(rect=[0, 0, 1, 0.84])
                pdf.savefig(fig)
                plt.close(fig)

        if not available_df.empty:
            delivery = available_df.groupby('plataforma')['tiempo_entrega_min'].mean().dropna()
            if not delivery.empty:
                fig, ax = plt.subplots(figsize=PAGE_SIZE)
                fig.text(0.07, 0.94, 'Tiempo de entrega promedio por plataforma', fontsize=14, weight='bold')
                fig.text(0.07, 0.91, descriptions['delivery'], fontsize=9)
                bar_colors = [PLATFORM_COLORS.get(p, '#888888') for p in delivery.index]
                delivery.plot(kind='bar', ax=ax, color=bar_colors, width=0.5, legend=False)
                ax.set_ylabel('Minutos promedio')
                ax.set_xlabel('')
                ax.tick_params(axis='x', rotation=0)
                for container in ax.containers:
                    ax.bar_label(container, fmt='%.1f min', padding=3, fontsize=9)
                fig.tight_layout(rect=[0, 0, 1, 0.86])
                pdf.savefig(fig)
                plt.close(fig)

        zone_comparison = build_zone_comparison(available_df)
        if zone_comparison:
            zone, rappi_value, uber_value = zone_comparison
            fig, ax = plt.subplots(figsize=PAGE_SIZE)
            fig.text(0.07, 0.94, 'Tiempo de entrega: zona con mayor brecha competitiva', fontsize=14, weight='bold')
            fig.text(0.07, 0.91, f'Zona: {zone}  |  Rappi {rappi_value:.0f} min vs Uber Eats {uber_value:.0f} min  |  Diferencia: {rappi_value - uber_value:.0f} min', fontsize=9)
            fig.text(0.07, 0.88, descriptions['zone_compare'], fontsize=8.5, color='#555555')
            bars = ax.bar(
                ['Rappi', 'Uber Eats'],
                [rappi_value, uber_value],
                color=[PLATFORM_COLORS['Rappi'], PLATFORM_COLORS['Uber Eats']],
                width=0.4,
            )
            ax.set_ylabel('Minutos de entrega')
            ax.set_xlabel('')
            ax.tick_params(axis='x', labelsize=12)
            for bar, val in zip(bars, [rappi_value, uber_value]):
                ax.text(bar.get_x() + bar.get_width() / 2, val + 0.3, f'{val:.0f} min',
                        ha='center', va='bottom', fontsize=11, weight='bold')
            fig.tight_layout(rect=[0, 0, 1, 0.84])
            pdf.savefig(fig)
            plt.close(fig)

        availability_zone = df.pivot_table(
            index='zona',
            columns='plataforma',
            values='disponible',
            aggfunc='mean'
        )
        if not availability_zone.empty:
            fig, ax = plt.subplots(figsize=PAGE_SIZE)
            fig.text(0.07, 0.94, 'Disponibilidad por zona y plataforma', fontsize=14, weight='bold')
            fig.text(0.07, 0.91, descriptions['availability_zone'], fontsize=9)
            bar_colors = [PLATFORM_COLORS.get(c, '#888888') for c in availability_zone.columns]
            availability_zone.plot(kind='bar', ax=ax, color=bar_colors, width=0.6)
            ax.set_ylabel('Tasa de disponibilidad (0-1)')
            ax.set_xlabel('')
            ax.set_ylim(0, 1.15)
            ax.tick_params(axis='x', rotation=45)
            ax.legend(title='Plataforma')
            fig.tight_layout(rect=[0, 0, 1, 0.86])
            pdf.savefig(fig)
            plt.close(fig)

        insights = build_top5_insights_llm(df, available_df)
        if insights:
            fig = plt.figure(figsize=PAGE_SIZE)
            fig.text(0.07, 0.95, 'Top 5 Insights Accionables', fontsize=16, weight='bold')
            y = 0.89
            for i, insight in enumerate(insights[:5], 1):
                fig.text(0.07, y, f'Insight {i}', fontsize=11, weight='bold', color='#1565C0')
                y -= 0.038
                for label, key in [('Finding', 'finding'), ('Impacto', 'impacto'), ('Recomendacion', 'recomendacion')]:
                    text = sanitize_matplotlib_text(textwrap.fill(f"{label}: {insight.get(key, '')}", width=88))
                    line_count = text.count('\n') + 1
                    fig.text(0.07, y, text, fontsize=8.5)
                    y -= 0.027 * line_count
                y -= 0.018
                if y < 0.05:
                    break
            plt.axis('off')
            pdf.savefig(fig)
            plt.close(fig)

    print(f'Reporte generado: {report_path}')


def parse_delivery_minutes(value: object) -> float | None:
    if value is None:
        return None

    text = str(value).lower()

    if text == 'unknown':
        return None

    numbers = [int(match) for match in re.findall(r'\d+', text)]
    if not numbers:
        return None

    if len(numbers) >= 2:
        return sum(numbers[:2]) / 2

    return float(numbers[0])


def has_discount(row: pd.Series) -> bool:
    discount = str(row.get('descuento_producto', '')).strip().lower()
    original = row.get('precio_producto_original')
    price = row.get('precio_producto')

    if original is not None and price is not None:
        try:
            return float(original) > float(price)
        except (TypeError, ValueError):
            return False

    if discount and discount not in {'unknown', 'none'}:
        return '%' in discount or any(char.isdigit() for char in discount)

    return False


def is_promo_fee(row: pd.Series) -> bool:
    promo = str(row.get('precio_envio_promo', '')).lower()
    return any(kw in promo for kw in ['usuarios nuevos', 'uber one', 'membresía', 'membresia', 'nueva'])


def build_top5_insights_llm(df: pd.DataFrame, available_df: pd.DataFrame) -> list[dict] | None:
    api_key = load_env_var('ANTHROPIC_API_KEY')
    if not api_key or Anthropic is None:
        return None

    if available_df.empty:
        return None

    price = (
        available_df
        .groupby(['plataforma', 'producto'])['precio_producto']
        .mean()
        .reset_index()
        .to_dict(orient='records')
    )
    delivery = (
        available_df
        .groupby('plataforma')['tiempo_entrega_min']
        .mean()
        .dropna()
        .to_dict()
    )
    availability = df.groupby('plataforma')['disponible'].mean().to_dict()
    discounts = available_df.groupby('plataforma')['tiene_descuento'].mean().to_dict()
    fee = (
        available_df
        .groupby('plataforma')['precio_envio']
        .mean()
        .dropna()
        .to_dict()
    )
    promo_fee_count = (
        available_df
        .groupby('plataforma')['precio_envio_es_promo']
        .sum()
        .to_dict()
    ) if 'precio_envio_es_promo' in available_df.columns else {}

    payload = {
        'avg_price_by_platform_product': price,
        'avg_delivery_min': delivery,
        'availability_rate': availability,
        'discount_rate': discounts,
        'avg_delivery_fee': fee,
        'promo_fee_records_count': promo_fee_count,
        'note': (
            'En Uber Eats, muchos registros con precio_envio=0 corresponden a promociones '
            'de usuario nuevo o suscripcion Uber One, no al precio base real.'
        ),
    }

    prompt = (
        'Eres un analista de competitive intelligence para Rappi Mexico. '
        'Basado en los datos de scraping de Rappi y Uber Eats, genera exactamente 5 insights accionables. '
        'Cada insight debe seguir este formato JSON:\n'
        '[{"finding": "...", "impacto": "...", "recomendacion": "..."}, ...]\n'
        'Cubre: precios, tiempos de entrega, fees de envio, descuentos y cobertura geografica. '
        'Usa numeros concretos cuando esten disponibles. '
        'Responde SOLO con el JSON array, sin texto adicional.\n'
        f'Datos: {payload}'
    )

    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=900,
            temperature=0.2,
            messages=[{'role': 'user', 'content': prompt}],
        )
        text = response.content[0].text if response.content else ''
    except Exception:
        return None

    try:
        import json
        return json.loads(text)
    except Exception:
        return None


def build_positioning_summary_llm(df: pd.DataFrame, available_df: pd.DataFrame) -> str | None:
    api_key = load_env_var('ANTHROPIC_API_KEY')
    if not api_key or Anthropic is None:
        return None

    if available_df.empty:
        return None

    price = (
        available_df
        .groupby(['plataforma', 'producto'])['precio_producto']
        .mean()
        .reset_index()
        .to_dict(orient='records')
    )
    delivery = (
        available_df
        .groupby('plataforma')['tiempo_entrega_min']
        .mean()
        .dropna()
        .to_dict()
    )
    availability = df.groupby('plataforma')['disponible'].mean().to_dict()
    fee = (
        available_df
        .groupby('plataforma')['precio_envio']
        .mean()
        .dropna()
        .to_dict()
    )

    payload = {
        'avg_price': price,
        'avg_delivery_min': delivery,
        'availability_rate': availability,
        'avg_delivery_fee': fee,
        'note': (
            'En Uber Eats, el precio_envio=0 frecuente refleja promociones de usuario nuevo '
            'o Uber One, no el precio base. Interpretarlo con cautela al comparar fees.'
        ),
    }

    prompt = (
        'Eres un analista senior de strategy para Rappi Mexico. '
        'En base a los datos de scraping comparativo con Uber Eats, escribe un resumen ejecutivo '
        'en espanol sobre el posicionamiento competitivo de Rappi. '
        'Estructura en 3 parrafos: '
        '1) Posicionamiento en precios vs competencia. '
        '2) Performance en tiempos de entrega y cobertura geografica. '
        '3) Oportunidades y riesgos clave identificados. '
        'Usa numeros concretos del JSON cuando esten disponibles. '
        'Texto plano, sin markdown, sin vinietas. Maximo 160 palabras. Oraciones completas, no cortes a mitad.\n'
        f'Datos: {payload}'
    )

    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=600,
            temperature=0.2,
            messages=[{'role': 'user', 'content': prompt}],
        )
        text = response.content[0].text if response.content else ''
    except Exception:
        return None

    return text


def build_zone_comparison(available_df: pd.DataFrame) -> tuple[str, float, float] | None:
    if available_df.empty:
        return None

    zone_platform = (
        available_df
        .dropna(subset=['tiempo_entrega_min'])
        .groupby(['zona', 'plataforma'])['tiempo_entrega_min']
        .mean()
        .unstack()
        .dropna()
    )

    if zone_platform.empty:
        return None

    rappi_worst_zone = zone_platform['Rappi'].idxmax()
    uber_best_zone = zone_platform['Uber Eats'].idxmin()

    if rappi_worst_zone in zone_platform.index:
        rappi_value = float(zone_platform.loc[rappi_worst_zone, 'Rappi'])
        uber_value = float(zone_platform.loc[rappi_worst_zone, 'Uber Eats'])
        return rappi_worst_zone, rappi_value, uber_value

    rappi_value = float(zone_platform.loc[uber_best_zone, 'Rappi'])
    uber_value = float(zone_platform.loc[uber_best_zone, 'Uber Eats'])
    return uber_best_zone, rappi_value, uber_value


def build_llm_summary(df: pd.DataFrame, available_df: pd.DataFrame) -> str | None:
    api_key = load_env_var('ANTHROPIC_API_KEY')
    if not api_key or Anthropic is None:
        return None

    if available_df.empty:
        return None

    price = (
        available_df
        .groupby(['plataforma', 'producto'])['precio_producto']
        .mean()
        .reset_index()
        .to_dict(orient='records')
    )

    delivery = (
        available_df
        .groupby('plataforma')['tiempo_entrega_min']
        .mean()
        .dropna()
        .to_dict()
    )

    availability = df.groupby('plataforma')['disponible'].mean().to_dict()
    availability_zone = (
        df.pivot_table(index='zona', columns='plataforma', values='disponible', aggfunc='mean')
        .fillna(0)
        .sort_values(by=list(df['plataforma'].dropna().unique()), ascending=False)
        .head(3)
        .reset_index()
        .to_dict(orient='records')
    )

    payload = {
        'totals': {
            'rows': int(len(df)),
            'available_rows': int(len(available_df)),
        },
        'records': available_df.to_dict(orient='records'),
        'availability_by_platform': availability,
        'avg_price_by_platform_product': price,
        'avg_delivery_minutes_by_platform': delivery,
        'top_zones_availability': availability_zone,
    }

    prompt = (
        'Genera un resumen ejecutivo en espanol de maximo 220 palabras con oraciones completas. '
        'Cubre: disponibilidad por plataforma, tiempos de entrega, precios por producto y diferencias clave. '
        'Usa numeros concretos. Texto plano, sin titulos, sin vinietas, sin cortar oraciones a mitad.'
        f'\nDatos: {payload}'
    )

    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=600,
            temperature=0.2,
            messages=[{'role': 'user', 'content': prompt}],
        )
    except Exception:
        return None

    text = response.content[0].text if response.content else ''
    return textwrap.fill(text, width=95)


def build_llm_descriptions(df: pd.DataFrame, available_df: pd.DataFrame) -> dict[str, str]:
    defaults = {
        'intro': (
            'Descripcion general: Este reporte resume precios, tiempos y disponibilidad por plataforma, '
            'usando los datos recolectados en output/*.json.'
        ),
        'price': (
            'Contexto: compara el precio promedio del mismo producto entre plataformas para medir '
            'diferencias competitivas.'
        ),
        'fee': 'Contexto: muestra el costo de envio promedio para comparar el impacto en el precio final.',
        'delivery': 'Contexto: estima la performance operativa comparando minutos promedio por plataforma.',
        'zone_compare': 'Contexto: compara la peor performance de Rappi con la mejor de Uber Eats en la misma zona.',
        'availability_zone': 'Contexto: identifica variaciones de cobertura por zona para detectar areas debiles.',
        'discounts': 'Contexto: cuenta cuantas veces aparece un descuento por producto en cada plataforma.',
    }

    api_key = load_env_var('ANTHROPIC_API_KEY')
    if not api_key or Anthropic is None:
        return defaults

    summary = build_llm_summary(df, available_df)
    payload = {
        'totals': {
            'rows': int(len(df)),
            'available_rows': int(len(available_df)),
        },
        'llm_summary': summary,
    }

    prompt = (
        'Genera descripciones breves (1-2 lineas) en espanol para cada seccion del reporte. '
        'Responde en JSON con las claves: intro, price, fee, delivery, zone_compare, availability_zone, discounts. '
        'Usa el contexto y evita repetir frases.\n'
        f'Contexto: {payload}'
    )

    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=250,
            temperature=0.2,
            messages=[{'role': 'user', 'content': prompt}],
        )
        text = response.content[0].text if response.content else ''
    except Exception:
        return defaults

    try:
        import json

        parsed = json.loads(text)
    except Exception:
        return defaults

    for key in defaults:
        value = parsed.get(key)
        if isinstance(value, str) and value.strip():
            defaults[key] = value.strip()

    return defaults


def load_env_var(name: str) -> str | None:
    if name in os.environ:
        return os.environ[name]

    env_path = Path('.') / '.env'
    if not env_path.exists():
        return None

    for line in env_path.read_text(encoding='utf-8').splitlines():
        if not line or line.strip().startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key.strip() == name:
            os.environ[name] = value.strip()
            return value.strip()

    return None


def sanitize_matplotlib_text(text: str | None) -> str | None:
    if text is None:
        return None

    return text.replace('$', '\\$')


if __name__ == '__main__':
    main()
