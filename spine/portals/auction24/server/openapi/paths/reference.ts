import { z } from 'zod'
import { registry } from '../registry'
import {
  json,
  CategorySchema,
  CategoryParamSchema,
  CountrySchema,
  CurrencySchema,
  LanguageSchema,
} from '../schemas/common'

export const registerReferencePaths = () => {
  registry.registerPath({
    method: 'get',
    path: '/api/categories',
    tags: ['reference'],
    summary: 'List vehicle categories',
    responses: {
      200: json(z.array(CategorySchema), 'Categories'),
    },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/category-params',
    tags: ['reference'],
    summary: 'List category parameter definitions',
    responses: {
      200: json(z.array(CategoryParamSchema), 'Category params'),
    },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/countries',
    tags: ['reference'],
    summary: 'List countries (ISO codes, phone code, VAT)',
    responses: {
      200: json(z.array(CountrySchema), 'Countries'),
    },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/currencies',
    tags: ['reference'],
    summary: 'List currencies',
    responses: {
      200: json(z.array(CurrencySchema), 'Currencies'),
    },
    security: [],
  })

  registry.registerPath({
    method: 'get',
    path: '/api/languages',
    tags: ['reference'],
    summary: 'List supported languages',
    responses: {
      200: json(z.array(LanguageSchema), 'Languages'),
    },
    security: [],
  })
}
