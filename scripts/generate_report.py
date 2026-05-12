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

    descriptions = build_llm_descriptions(df, available_df)

    with PdfPages(report_path) as pdf:
        fig = plt.figure(figsize=(8.5, 11))
        fig.text(0.07, 0.93, 'Competitive Intelligence - Resumen de Scrapeos', fontsize=16, weight='bold')
        fig.text(0.07, 0.89, f'Registros totales: {len(df)}', fontsize=11)
        fig.text(0.07, 0.86, f'Registros disponibles: {len(available_df)}', fontsize=11)
        fig.text(
            0.07,
            0.82,
            descriptions['intro'],
            fontsize=10,
        )
        fig.text(0.07, 0.76, 'Notas:', fontsize=12, weight='bold')
        notes = [
            '- Los resultados reflejan el horario de ejecucion (posibles locales cerrados).',
            '- Cuando un local no aparece o no dispara endpoint, se registra como no disponible.',
        ]
        fig.text(0.07, 0.72, '\n'.join(notes), fontsize=10)
        plt.axis('off')
        pdf.savefig(fig, bbox_inches='tight')
        plt.close(fig)

        llm_summary = sanitize_matplotlib_text(build_llm_summary(df, available_df))
        if llm_summary:
            fig = plt.figure(figsize=(8.5, 11))
            fig.text(0.07, 0.95, 'Resumen LLM', fontsize=16, weight='bold')
            fig.text(0.07, 0.90, llm_summary, fontsize=9, va='top')
            plt.axis('off')
            pdf.savefig(fig, bbox_inches='tight')
            plt.close(fig)

        if not available_df.empty:
            price = (
                available_df
                .groupby(['plataforma', 'producto'])['precio_producto']
                .mean()
                .reset_index()
            )
            fig, ax = plt.subplots(figsize=(8.5, 11))
            fig.text(0.07, 0.93, 'Precio promedio por producto y plataforma', fontsize=14, weight='bold')
            fig.text(
                0.07,
                0.90,
                descriptions['price'],
                fontsize=10,
            )
            for platform in price['plataforma'].unique():
                subset = price[price['plataforma'] == platform]
                ax.bar(subset['producto'] + ' - ' + platform, subset['precio_producto'])
            ax.set_ylabel('Precio')
            ax.set_xlabel('Producto - Plataforma')
            ax.tick_params(axis='x', rotation=30)
            fig.tight_layout(rect=[0, 0, 1, 0.85])
            pdf.savefig(fig, bbox_inches='tight')
            plt.close(fig)

        if not available_df.empty:
            discounts = (
                available_df
                .groupby(['plataforma', 'producto'])['tiene_descuento']
                .sum()
                .reset_index()
            )
            if not discounts.empty:
                fig, ax = plt.subplots(figsize=(8.5, 11))
                fig.text(0.07, 0.93, 'Conteo de descuentos por producto y plataforma', fontsize=14, weight='bold')
                fig.text(
                    0.07,
                    0.90,
                    descriptions.get(
                        'discounts',
                        'Contexto: cuenta cuantas veces aparece un descuento por producto en cada plataforma.',
                    ),
                    fontsize=10,
                )
                for platform in discounts['plataforma'].unique():
                    subset = discounts[discounts['plataforma'] == platform]
                    ax.bar(subset['producto'] + ' - ' + platform, subset['tiene_descuento'])
                ax.set_ylabel('Cantidad de descuentos')
                ax.set_xlabel('Producto - Plataforma')
                ax.tick_params(axis='x', rotation=30)
                fig.tight_layout(rect=[0, 0, 1, 0.85])
                pdf.savefig(fig, bbox_inches='tight')
                plt.close(fig)

        if not available_df.empty:
            fee = available_df.groupby('plataforma')['precio_envio'].mean().dropna()
            if not fee.empty:
                fig, ax = plt.subplots(figsize=(8.5, 11))
                fig.text(0.07, 0.93, 'Costo de envio promedio por plataforma', fontsize=14, weight='bold')
                fig.text(
                    0.07,
                    0.90,
                    descriptions['fee'],
                    fontsize=10,
                )
                fee.plot(kind='bar', ax=ax)
                ax.set_ylabel('Costo de envio')
                ax.set_xlabel('Plataforma')
                fig.tight_layout(rect=[0, 0, 1, 0.85])
                pdf.savefig(fig, bbox_inches='tight')
                plt.close(fig)

        if not available_df.empty:
            delivery = available_df.groupby('plataforma')['tiempo_entrega_min'].mean().dropna()
            if not delivery.empty:
                fig, ax = plt.subplots(figsize=(8.5, 11))
                fig.text(0.07, 0.93, 'Tiempo de entrega promedio por plataforma', fontsize=14, weight='bold')
                fig.text(
                    0.07,
                    0.90,
                    descriptions['delivery'],
                    fontsize=10,
                )
                delivery.plot(kind='bar', ax=ax)
                ax.set_ylabel('Minutos')
                ax.set_xlabel('Plataforma')
                fig.tight_layout(rect=[0, 0, 1, 0.85])
                pdf.savefig(fig, bbox_inches='tight')
                plt.close(fig)

        zone_comparison = build_zone_comparison(available_df)
        if zone_comparison:
            zone, rappi_value, uber_value = zone_comparison
            fig, ax = plt.subplots(figsize=(8.5, 11))
            fig.text(0.07, 0.93, f'Peor Rappi vs mejor Uber Eats en {zone}', fontsize=14, weight='bold')
            fig.text(
                0.07,
                0.90,
                descriptions['zone_compare'],
                fontsize=10,
            )
            ax.bar(['Rappi (peor)', 'Uber Eats (mejor)'], [rappi_value, uber_value])
            ax.set_ylabel('Minutos')
            ax.set_xlabel('Plataforma')
            fig.tight_layout(rect=[0, 0, 1, 0.85])
            pdf.savefig(fig, bbox_inches='tight')
            plt.close(fig)

        availability_zone = df.pivot_table(
            index='zona',
            columns='plataforma',
            values='disponible',
            aggfunc='mean'
        )
        if not availability_zone.empty:
            fig, ax = plt.subplots(figsize=(8.5, 11))
            fig.text(0.07, 0.93, 'Disponibilidad por zona y plataforma', fontsize=14, weight='bold')
            fig.text(
                0.07,
                0.90,
                descriptions['availability_zone'],
                fontsize=10,
            )
            availability_zone.plot(kind='bar', ax=ax)
            ax.set_ylabel('Disponibilidad promedio')
            ax.set_xlabel('Zona')
            ax.tick_params(axis='x', rotation=45)
            fig.tight_layout(rect=[0, 0, 1, 0.85])
            pdf.savefig(fig, bbox_inches='tight')
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
        'Genera un resumen en espanol con 2 lineas por item para:\n'
        '1) Plataforma (Rappi, Uber Eats)\n'
        '2) Producto (Big Mac, Whopper, Coca-Cola 600 ml)\n'
        '3) Zona (top 3 zonas)\n'
        'Usa el JSON de datos como contexto y menciona diferencias relevantes.\n'
        'Responde en texto plano, sin vinietas.\n'
        f'Datos: {payload}'
    )

    try:
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model='claude-sonnet-4-6',
            max_tokens=300,
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
